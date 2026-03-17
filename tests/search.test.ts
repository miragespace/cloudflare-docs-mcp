import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHUNK_CHAR_LIMIT,
  DEFAULT_CORPUS_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_HOST,
  DEFAULT_MCP_PATH,
  DEFAULT_MODEL_DEVICE,
  DEFAULT_PORT,
  DEFAULT_RERANK_MODEL,
} from "../src/constants.js";
import { chunkPage } from "../src/chunking.js";
import { DatabaseStore } from "../src/db.js";
import { parsePage } from "../src/parser.js";
import { SearchEngine } from "../src/search.js";
import type { AppConfig, ModelClient } from "../src/types.js";

class FakeModelClient implements ModelClient {
  async warmup(): Promise<void> {}

  async close(): Promise<void> {}

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return Float32Array.from([
        /(durable|stateful|actor|memory)/.test(lower) ? 1 : 0,
        /(wrangler|remote|cli|flag)/.test(lower) ? 1 : 0,
        /(browser|screenshot|render)/.test(lower) ? 1 : 0,
      ]);
    });
  }

  async rerank(query: string, candidates: string[]): Promise<number[]> {
    const lowerQuery = query.toLowerCase();
    return candidates.map((candidate) => {
      const lowerCandidate = candidate.toLowerCase();
      let score = 0;
      for (const term of lowerQuery.split(/\s+/)) {
        if (term !== "" && lowerCandidate.includes(term)) {
          score += 0.25;
        }
      }
      return score;
    });
  }
}

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeConfig(rootDir: string): AppConfig {
  const dataDir = join(rootDir, "data");
  return {
    server: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      mcpPath: DEFAULT_MCP_PATH,
      allowedHosts: [],
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, "docs.sqlite"),
      stageDbPath: join(dataDir, "docs.sqlite.next"),
      corpusPath: join(dataDir, "llms-full.txt"),
      tempCorpusPath: join(dataDir, "llms-full.txt.download"),
      modelCacheDir: join(dataDir, "models"),
    },
    corpus: {
      sourceUrl: DEFAULT_CORPUS_URL,
      timeoutMs: 10_000,
    },
    models: {
      embeddingModelId: DEFAULT_EMBEDDING_MODEL,
      rerankerModelId: DEFAULT_RERANK_MODEL,
      device: DEFAULT_MODEL_DEVICE,
    },
    search: {
      defaultLimit: 8,
      maxLimit: 20,
      chunkCharLimit: DEFAULT_CHUNK_CHAR_LIMIT,
      semanticCandidateLimit: 10,
      rerankTopK: 5,
      embeddingBatchSize: 8,
    },
  };
}

async function seedStore(store: DatabaseStore, modelClient: FakeModelClient, rawPage: string, config: AppConfig): Promise<void> {
  const page = parsePage(`${rawPage}\n`);
  const chunks = chunkPage(page, config.search.chunkCharLimit);
  const chunkIds = store.insertPage(page, chunks);
  const vectors = await modelClient.embedTexts(chunks.map((chunk) => chunk.searchText));
  store.insertEmbeddings(chunkIds, vectors, config.models.embeddingModelId);
}

describe("search engine", () => {
  it("finds exact flags through lexical search", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudflare-docs-mcp-search-"));
    createdDirs.push(dir);
    const config = makeConfig(dir);
    const store = new DatabaseStore(config.storage.dbPath);
    const modelClient = new FakeModelClient();

    await seedStore(
      store,
      modelClient,
      `---
title: Wrangler CLI · Cloudflare Workers docs
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/workers/wrangler/
  md: https://developers.cloudflare.com/workers/wrangler/index.md
---

Use \`wrangler dev --remote\` to run your Worker against Cloudflare infrastructure.`,
      config,
    );

    const search = new SearchEngine(config, store, modelClient);
    const results = await search.search("--remote", {
      mode: "keyword",
      limit: 5,
      includeDeprioritized: false,
    });

    expect(results[0]?.title).toContain("Wrangler CLI");
    expect(results[0]?.snippet).toContain("wrangler dev --remote");
    await search.close();
    store.close();
  });

  it("finds conceptually related docs through semantic search", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudflare-docs-mcp-semantic-"));
    createdDirs.push(dir);
    const config = makeConfig(dir);
    const store = new DatabaseStore(config.storage.dbPath);
    const modelClient = new FakeModelClient();

    await seedStore(
      store,
      modelClient,
      `---
title: Durable Objects · Cloudflare Workers docs
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/durable-objects/
  md: https://developers.cloudflare.com/durable-objects/index.md
---

Durable Objects provide stateful coordination and storage for actor-style applications.`,
      config,
    );

    await seedStore(
      store,
      modelClient,
      `---
title: Browser Rendering · Cloudflare Browser Rendering docs
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/browser-rendering/
  md: https://developers.cloudflare.com/browser-rendering/index.md
---

Use Browser Rendering to capture screenshots and scrape pages with a headless browser.`,
      config,
    );

    const search = new SearchEngine(config, store, modelClient);
    const results = await search.search("actor memory", {
      mode: "semantic",
      limit: 5,
      includeDeprioritized: false,
    });

    expect(results[0]?.title).toContain("Durable Objects");
    await search.close();
    store.close();
  });
});
