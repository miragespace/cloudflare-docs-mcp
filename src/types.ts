import type { MODEL_DEVICE_VALUES } from "./constants.js";

export type ModelDevice = (typeof MODEL_DEVICE_VALUES)[number];

export interface AppConfig {
  server: {
    host: string;
    port: number;
    mcpPath: string;
    allowedHosts: string[];
  };
  storage: {
    dataDir: string;
    dbPath: string;
    stageDbPath: string;
    corpusPath: string;
    tempCorpusPath: string;
    modelCacheDir: string;
  };
  corpus: {
    sourceUrl: string;
    timeoutMs: number;
  };
  models: {
    embeddingModelId: string;
    rerankerModelId: string;
    device: ModelDevice;
  };
  search: {
    defaultLimit: number;
    maxLimit: number;
    chunkCharLimit: number;
    semanticCandidateLimit: number;
    rerankTopK: number;
    embeddingBatchSize: number;
  };
}

export interface SourceUrls {
  html: string;
  md: string;
}

export interface ParsedPage {
  rawPage: string;
  markdownBody: string;
  title: string;
  description?: string | undefined;
  lastUpdated?: string | undefined;
  chatbotDeprioritize: boolean;
  tags: string[];
  sourceUrl: SourceUrls;
}

export interface ChunkInput {
  chunkIndex: number;
  headingPath: string;
  content: string;
  searchText: string;
  charCount: number;
}

export interface DocumentRow {
  id: number;
  title: string;
  description: string | null;
  lastUpdated: string | null;
  chatbotDeprioritize: boolean;
  tags: string[];
  sourceHtmlUrl: string;
  sourceMdUrl: string;
  canonicalUrl: string;
  urlPath: string;
  markdown: string;
}

export interface SearchResult {
  documentId: number;
  chunkId: number;
  title: string;
  sourceHtmlUrl: string;
  sourceMdUrl: string;
  headingPath: string;
  snippet: string;
  score: number;
  lexicalRank?: number | undefined;
  semanticRank?: number | undefined;
  rerankScore?: number | undefined;
  chatbotDeprioritize: boolean;
  resourceUri: string;
}

export interface SearchOptions {
  mode: "hybrid" | "keyword" | "semantic";
  limit: number;
  product?: string | undefined;
  includeDeprioritized: boolean;
}

export interface SyncRunRecord {
  id: number;
  sourceUrl: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  downloadedAt: string;
  status: string;
  documentCount: number;
  chunkCount: number;
  excluded404Count: number;
  excludedLicenseCount: number;
  errorMessage: string | null;
}

export interface SyncSummary {
  sourceUrl: string;
  downloadedAt: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  totalPages: number;
  storedDocuments: number;
  storedChunks: number;
  excluded404Count: number;
  excludedLicenseCount: number;
  notModified: boolean;
}

export interface StatusReport {
  databaseReady: boolean;
  dbPath: string;
  corpusPath: string;
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  lastSync?: SyncRunRecord | undefined;
}

export interface EmbeddingRow {
  chunkId: number;
  documentId: number;
  title: string;
  sourceHtmlUrl: string;
  sourceMdUrl: string;
  chatbotDeprioritize: boolean;
  headingPath: string;
  content: string;
  vector: Float32Array;
}

export interface LexicalCandidate {
  chunkId: number;
  documentId: number;
  title: string;
  sourceHtmlUrl: string;
  sourceMdUrl: string;
  chatbotDeprioritize: boolean;
  headingPath: string;
  content: string;
  snippet: string;
  lexicalScore: number;
}

export interface ModelRuntimeConfig {
  cacheDir: string;
  allowRemoteModels: boolean;
  embeddingModelId: string;
  rerankerModelId: string;
  device: ModelDevice;
}

export interface ModelClient {
  warmup(): Promise<void>;
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  rerank(query: string, candidates: string[]): Promise<number[]>;
  close(): Promise<void>;
}
