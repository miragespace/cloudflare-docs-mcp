export const APP_NAME = "cloudflare-docs-mcp";
export const APP_VERSION = "0.1.0";
export const DEFAULT_MCP_PATH = "/mcp";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_CORPUS_URL = "https://developers.cloudflare.com/llms-full.txt";
export const DEFAULT_CONFIG_FILE = "cloudflare-docs-mcp.config.json";
export const DEFAULT_DATA_DIR = "data";
export const DEFAULT_DB_FILE = "cloudflare-docs.sqlite";
export const DEFAULT_CORPUS_FILE = "llms-full.txt";
export const DEFAULT_MODEL_CACHE_DIR = "models-cache";
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
export const DEFAULT_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";
export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const DEFAULT_MODEL_DEVICE = "cpu";
export const DEFAULT_CHUNK_CHAR_LIMIT = 2000;
export const FUSION_RANK_CONSTANT = 60;

export const PAGE_OPEN = "<page>";
export const PAGE_CLOSE = "</page>";
export const TITLE_404_PREFIX = "404 - Page Not Found";
export const TITLE_LICENSE_PREFIX = "Third party licenses";

export const MODEL_DEVICE_VALUES = [
  "auto",
  "gpu",
  "cpu",
  "wasm",
  "webgpu",
  "cuda",
  "dml",
  "webnn",
  "webnn-npu",
  "webnn-gpu",
  "webnn-cpu",
] as const;
