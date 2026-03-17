import { copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseStore } from "./db.js";
import { chunkPage } from "./chunking.js";
import { parseCorpusFile, isExcludedTitle } from "./parser.js";
import type { AppConfig, ModelClient, SyncSummary } from "./types.js";
import { ensureDir, ensureParentDir, fileExists, fileSize, sha256Hex } from "./utils.js";

interface DownloadResult {
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  downloadedAt: string;
  corpusPath: string;
}

type ProgressReporter = (message: string) => void;

export async function embedTextsBatched(
  modelClient: ModelClient,
  texts: string[],
  batchSize: number,
): Promise<Float32Array[]> {
  const effectiveBatchSize = Math.max(1, batchSize);
  const vectors: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += effectiveBatchSize) {
    const batch = texts.slice(start, start + effectiveBatchSize);
    const batchVectors = await modelClient.embedTexts(batch);
    vectors.push(...batchVectors);
  }

  return vectors;
}

async function resolveReusableLocalCorpus(config: AppConfig, report: ProgressReporter): Promise<DownloadResult | undefined> {
  const candidates = [config.storage.tempCorpusPath, config.storage.corpusPath];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }

    const size = await fileSize(candidate);
    if (size <= 0) {
      continue;
    }

    if (candidate === config.storage.corpusPath) {
      await ensureParentDir(config.storage.tempCorpusPath);
      await copyFile(config.storage.corpusPath, config.storage.tempCorpusPath);
    }

    const buffer = await readFile(config.storage.tempCorpusPath);
    const info = await stat(candidate);
    report(`Reusing local corpus at ${candidate} (${size} bytes).`);
    return {
      notModified: false,
      etag: null,
      lastModified: null,
      contentHash: sha256Hex(buffer),
      downloadedAt: info.mtime.toISOString(),
      corpusPath: config.storage.tempCorpusPath,
    };
  }

  return undefined;
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Timed out downloading corpus from ${url} after ${timeoutMs}ms.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download corpus from ${url}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadCorpus(
  config: AppConfig,
  existing: { etag: string | null; lastModified: string | null } | undefined,
  report: ProgressReporter,
): Promise<DownloadResult> {
  const headers: Record<string, string> = {};
  if (existing?.etag) {
    headers["if-none-match"] = existing.etag;
  }
  if (existing?.lastModified) {
    headers["if-modified-since"] = existing.lastModified;
  }

  report(`Downloading corpus from ${config.corpus.sourceUrl}`);

  try {
    const response = await fetchWithTimeout(config.corpus.sourceUrl, config.corpus.timeoutMs, headers);
    if (response.status === 304) {
      report("Remote corpus not modified.");
      return {
        notModified: true,
        etag: existing?.etag ?? null,
        lastModified: existing?.lastModified ?? null,
        contentHash: "",
        downloadedAt: new Date().toISOString(),
        corpusPath: config.storage.corpusPath,
      };
    }

    if (!response.ok) {
      throw new Error(`Failed to download corpus: ${response.status} ${response.statusText}`);
    }

    await ensureParentDir(config.storage.tempCorpusPath);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(config.storage.tempCorpusPath, buffer);
    report(`Downloaded corpus to ${config.storage.tempCorpusPath} (${buffer.byteLength} bytes)`);

    return {
      notModified: false,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentHash: sha256Hex(buffer),
      downloadedAt: new Date().toISOString(),
      corpusPath: config.storage.tempCorpusPath,
    };
  } catch (error) {
    const fallbacks = [config.storage.tempCorpusPath, config.storage.corpusPath];

    for (const fallbackPath of fallbacks) {
      if (!(await fileExists(fallbackPath))) {
        continue;
      }

      const size = await fileSize(fallbackPath);
      if (size <= 0) {
        continue;
      }

      if (fallbackPath === config.storage.corpusPath) {
        await ensureParentDir(config.storage.tempCorpusPath);
        await copyFile(config.storage.corpusPath, config.storage.tempCorpusPath);
      }

      const localBuffer = await readFile(config.storage.tempCorpusPath);
      const info = await stat(fallbackPath);
      report(
        `Download failed (${error instanceof Error ? error.message : String(error)}). Reusing local corpus at ${fallbackPath} (${size} bytes).`,
      );

      return {
        notModified: false,
        etag: existing?.etag ?? null,
        lastModified: existing?.lastModified ?? null,
        contentHash: sha256Hex(localBuffer),
        downloadedAt: info.mtime.toISOString(),
        corpusPath: config.storage.tempCorpusPath,
      };
    }

    throw error;
  }
}

async function buildDatabase(
  config: AppConfig,
  modelClient: ModelClient,
  download: DownloadResult,
  report: ProgressReporter,
): Promise<SyncSummary> {
  await ensureDir(config.storage.dataDir);
  await rm(config.storage.stageDbPath, { force: true });
  const store = new DatabaseStore(config.storage.stageDbPath);

  let totalPages = 0;
  let storedDocuments = 0;
  let storedChunks = 0;
  let excluded404Count = 0;
  let excludedLicenseCount = 0;
  let lastReportedPages = 0;

  try {
    report(`Building staged index from ${download.corpusPath}`);
    await parseCorpusFile(download.corpusPath, async (page) => {
      totalPages += 1;
      const excluded = isExcludedTitle(page.title);
      if (excluded.excluded) {
        if (excluded.reason === "404") {
          excluded404Count += 1;
        } else {
          excludedLicenseCount += 1;
        }
        return;
      }

      const chunks = chunkPage(page, config.search.chunkCharLimit);
      const chunkIds = store.insertPage(page, chunks);
      const vectors = await embedTextsBatched(
        modelClient,
        chunks.map((chunk) => chunk.searchText),
        config.search.embeddingBatchSize,
      );
      store.insertEmbeddings(chunkIds, vectors, config.models.embeddingModelId);
      storedDocuments += 1;
      storedChunks += chunks.length;

      if (totalPages - lastReportedPages >= 250) {
        lastReportedPages = totalPages;
        report(
          `Indexed ${totalPages} pages (${storedDocuments} stored, ${storedChunks} chunks, ${excluded404Count} excluded 404, ${excludedLicenseCount} excluded licenses)`,
        );
      }
    });

    const summary: SyncSummary = {
      sourceUrl: config.corpus.sourceUrl,
      downloadedAt: download.downloadedAt,
      contentHash: download.contentHash,
      etag: download.etag,
      lastModified: download.lastModified,
      totalPages,
      storedDocuments,
      storedChunks,
      excluded404Count,
      excludedLicenseCount,
      notModified: false,
    };
    store.appendSyncRun(summary, "success");
    store.close();
    return summary;
  } catch (error) {
    const summary: SyncSummary = {
      sourceUrl: config.corpus.sourceUrl,
      downloadedAt: download.downloadedAt,
      contentHash: download.contentHash || sha256Hex(""),
      etag: download.etag,
      lastModified: download.lastModified,
      totalPages,
      storedDocuments,
      storedChunks,
      excluded404Count,
      excludedLicenseCount,
      notModified: false,
    };
    store.appendSyncRun(summary, "failed", error instanceof Error ? error.message : String(error));
    store.close();
    throw error;
  }
}

async function swapArtifacts(config: AppConfig): Promise<void> {
  await ensureDir(config.storage.dataDir);
  await rename(config.storage.stageDbPath, config.storage.dbPath);
  await rename(config.storage.tempCorpusPath, config.storage.corpusPath);
}

export async function runSync(
  config: AppConfig,
  modelClient: ModelClient,
  report: ProgressReporter = () => undefined,
): Promise<SyncSummary> {
  await ensureDir(config.storage.dataDir);
  report("Checking local index state");

  let latestSync:
    | {
        etag: string | null;
        lastModified: string | null;
        contentHash: string;
      }
    | undefined;
  if (await fileExists(config.storage.dbPath)) {
    const currentStore = new DatabaseStore(config.storage.dbPath, { readonly: true });
    const latest = currentStore.getLatestSync();
    currentStore.close();
    if (latest) {
      latestSync = {
        etag: latest.etag,
        lastModified: latest.lastModified,
        contentHash: latest.contentHash,
      };
    }
  }

  const download = await downloadCorpus(config, latestSync, report);
  if (download.notModified) {
    return {
      sourceUrl: config.corpus.sourceUrl,
      downloadedAt: download.downloadedAt,
      contentHash: latestSync?.contentHash ?? "",
      etag: download.etag,
      lastModified: download.lastModified,
      totalPages: 0,
      storedDocuments: 0,
      storedChunks: 0,
      excluded404Count: 0,
      excludedLicenseCount: 0,
      notModified: true,
    };
  }

  report(`Warming models on device=${config.models.device}`);
  try {
    await modelClient.warmup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model warmup failed on device=${config.models.device}: ${message}`);
  }
  report("Model warmup complete");
  const summary = await buildDatabase(config, modelClient, download, report);
  report("Swapping staged artifacts into place");
  await rm(config.storage.dbPath, { force: true });
  await rm(config.storage.corpusPath, { force: true });
  await swapArtifacts(config);
  report("Sync complete");
  return summary;
}

export async function runSetup(
  config: AppConfig,
  modelClient: ModelClient,
  report: ProgressReporter = () => undefined,
): Promise<SyncSummary> {
  const reusableLocalCorpus = await resolveReusableLocalCorpus(config, report);
  if (reusableLocalCorpus) {
    report(`Warming models on device=${config.models.device}`);
    try {
      await modelClient.warmup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Model warmup failed on device=${config.models.device}: ${message}`);
    }
    report("Model warmup complete");
    const summary = await buildDatabase(config, modelClient, reusableLocalCorpus, report);
    report("Swapping staged artifacts into place");
    await rm(config.storage.dbPath, { force: true });
    await rm(config.storage.corpusPath, { force: true });
    await swapArtifacts(config);
    report("Setup complete");
    return summary;
  }

  const summary = await runSync(config, modelClient, report);
  if (summary.notModified && await fileExists(config.storage.corpusPath)) {
    await copyFile(config.storage.corpusPath, config.storage.tempCorpusPath).catch(() => undefined);
  }
  return summary;
}
