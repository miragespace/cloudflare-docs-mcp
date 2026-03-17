import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  APP_NAME,
  DEFAULT_CHUNK_CHAR_LIMIT,
  DEFAULT_CONFIG_FILE,
  DEFAULT_CORPUS_FILE,
  DEFAULT_CORPUS_URL,
  DEFAULT_DATA_DIR,
  DEFAULT_DB_FILE,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_HOST,
  DEFAULT_LIMIT,
  DEFAULT_MCP_PATH,
  DEFAULT_MODEL_CACHE_DIR,
  DEFAULT_MODEL_DEVICE,
  DEFAULT_PORT,
  DEFAULT_RERANK_MODEL,
  MAX_LIMIT,
  MODEL_DEVICE_VALUES,
} from "./constants.js";
import type { AppConfig, ModelDevice } from "./types.js";

const modelDeviceSchema = z.enum(MODEL_DEVICE_VALUES);

const configSchema = z.object({
  server: z.object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    mcpPath: z.string().optional(),
    allowedHosts: z.array(z.string()).optional(),
  }).optional(),
  storage: z.object({
    dataDir: z.string().optional(),
    modelCacheDir: z.string().optional(),
  }).optional(),
  corpus: z.object({
    sourceUrl: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
  models: z.object({
    embeddingModelId: z.string().optional(),
    rerankerModelId: z.string().optional(),
    device: modelDeviceSchema.optional(),
  }).optional(),
  search: z.object({
    defaultLimit: z.number().int().positive().optional(),
    maxLimit: z.number().int().positive().optional(),
    chunkCharLimit: z.number().int().positive().optional(),
    semanticCandidateLimit: z.number().int().positive().optional(),
    rerankTopK: z.number().int().positive().optional(),
    embeddingBatchSize: z.number().int().positive().optional(),
  }).optional(),
});

function stripJsonComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseModelDevice(value: string | undefined): ModelDevice | undefined {
  if (value === undefined) {
    return undefined;
  }
  return modelDeviceSchema.parse(value);
}

async function readConfigFile(cwd: string, fileName: string): Promise<z.infer<typeof configSchema>> {
  const configPath = resolve(cwd, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    return configSchema.parse(JSON.parse(stripJsonComments(raw)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function loadConfig(
  cwd = process.cwd(),
  overrides?: { modelDevice?: ModelDevice | undefined },
): Promise<AppConfig> {
  const configFileName = process.env.CLOUDFLARE_DOCS_MCP_CONFIG ?? DEFAULT_CONFIG_FILE;
  const loaded = await readConfigFile(cwd, configFileName);

  const dataDir = resolve(
    cwd,
    process.env.CLOUDFLARE_DOCS_MCP_DATA_DIR
      ?? loaded.storage?.dataDir
      ?? DEFAULT_DATA_DIR,
  );
  const modelCacheDir = resolve(
    dataDir,
    loaded.storage?.modelCacheDir ?? DEFAULT_MODEL_CACHE_DIR,
  );

  return {
    server: {
      host: process.env.CLOUDFLARE_DOCS_MCP_HOST ?? loaded.server?.host ?? DEFAULT_HOST,
      port: Number(process.env.CLOUDFLARE_DOCS_MCP_PORT ?? loaded.server?.port ?? DEFAULT_PORT),
      mcpPath: loaded.server?.mcpPath ?? DEFAULT_MCP_PATH,
      allowedHosts: loaded.server?.allowedHosts ?? [],
    },
    storage: {
      dataDir,
      dbPath: resolve(dataDir, DEFAULT_DB_FILE),
      stageDbPath: resolve(dataDir, `${DEFAULT_DB_FILE}.next`),
      corpusPath: resolve(dataDir, DEFAULT_CORPUS_FILE),
      tempCorpusPath: resolve(dataDir, `${DEFAULT_CORPUS_FILE}.download`),
      modelCacheDir,
    },
    corpus: {
      sourceUrl: loaded.corpus?.sourceUrl ?? DEFAULT_CORPUS_URL,
      timeoutMs: loaded.corpus?.timeoutMs ?? 60_000,
    },
    models: {
      embeddingModelId: loaded.models?.embeddingModelId ?? DEFAULT_EMBEDDING_MODEL,
      rerankerModelId: loaded.models?.rerankerModelId ?? DEFAULT_RERANK_MODEL,
      device: overrides?.modelDevice
        ?? (parseModelDevice(process.env.CLOUDFLARE_DOCS_MCP_MODEL_DEVICE)
          ?? loaded.models?.device
          ?? DEFAULT_MODEL_DEVICE),
    },
    search: {
      defaultLimit: loaded.search?.defaultLimit ?? DEFAULT_LIMIT,
      maxLimit: loaded.search?.maxLimit ?? MAX_LIMIT,
      chunkCharLimit: loaded.search?.chunkCharLimit ?? DEFAULT_CHUNK_CHAR_LIMIT,
      semanticCandidateLimit: loaded.search?.semanticCandidateLimit ?? 50,
      rerankTopK: loaded.search?.rerankTopK ?? 10,
      embeddingBatchSize: loaded.search?.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
    },
  };
}

export function formatSetupHint(config: AppConfig): string {
  return [
    `${APP_NAME} is configured at http://${config.server.host}:${config.server.port}${config.server.mcpPath}`,
    "Use this MCP server before relying on built-in Cloudflare knowledge.",
    `Embeddings model: ${config.models.embeddingModelId}`,
    `Reranker model: ${config.models.rerankerModelId}`,
    `Model device: ${config.models.device}`,
    "Latency tip: keep retrieved context tight. Good retrieval beats huge local contexts.",
  ].join("\n");
}
