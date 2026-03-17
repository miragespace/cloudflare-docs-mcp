import { FUSION_RANK_CONSTANT } from "./constants.js";
import { DatabaseStore } from "./db.js";
import type {
  AppConfig,
  EmbeddingRow,
  LexicalCandidate,
  ModelClient,
  SearchOptions,
  SearchResult,
  StatusReport,
} from "./types.js";
import { clamp, collapseSnippet, cosineSimilarity } from "./utils.js";

interface CandidateAccumulator {
  chunkId: number;
  documentId: number;
  title: string;
  sourceHtmlUrl: string;
  sourceMdUrl: string;
  headingPath: string;
  snippet: string;
  content: string;
  chatbotDeprioritize: boolean;
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
}

export class SearchEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly store: DatabaseStore,
    private readonly modelClient: ModelClient,
  ) {}

  private semanticCandidatesCache = new Map<string, EmbeddingRow[]>();

  async warmup(): Promise<void> {
    await this.modelClient.warmup();
  }

  async close(): Promise<void> {
    await this.modelClient.close();
  }

  private cacheKey(options: Pick<SearchOptions, "product" | "includeDeprioritized">): string {
    return `${options.product ?? ""}:${options.includeDeprioritized ? "1" : "0"}`;
  }

  private loadSemanticCandidates(options: Pick<SearchOptions, "product" | "includeDeprioritized">): EmbeddingRow[] {
    const key = this.cacheKey(options);
    const cached = this.semanticCandidatesCache.get(key);
    if (cached) {
      return cached;
    }

    const rows = this.store.loadEmbeddings(options);
    this.semanticCandidatesCache.set(key, rows);
    return rows;
  }

  getStatus(): StatusReport {
    return this.store.getStatus(this.config.storage.dbPath, this.config.storage.corpusPath);
  }

  getDocument(identifier: { docId?: number | undefined; url?: string | undefined }) {
    return this.store.getDocumentByIdOrUrl(identifier);
  }

  private mergeLexical(candidates: CandidateAccumulator[], lexical: LexicalCandidate[]): void {
    for (const [index, hit] of lexical.entries()) {
      const existing = candidates.find((candidate) => candidate.chunkId === hit.chunkId);
      const contribution = 1 / (FUSION_RANK_CONSTANT + index + 1);
      if (existing) {
        existing.score += contribution;
        existing.lexicalRank = index + 1;
        continue;
      }

      candidates.push({
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        title: hit.title,
        sourceHtmlUrl: hit.sourceHtmlUrl,
        sourceMdUrl: hit.sourceMdUrl,
        headingPath: hit.headingPath,
        snippet: collapseSnippet(hit.snippet),
        content: hit.content,
        chatbotDeprioritize: hit.chatbotDeprioritize,
        score: contribution,
        lexicalRank: index + 1,
      });
    }
  }

  private async mergeSemantic(
    candidates: CandidateAccumulator[],
    query: string,
    options: SearchOptions,
  ): Promise<void> {
    const rows = this.loadSemanticCandidates(options);
    if (rows.length === 0) {
      return;
    }

    const [queryVector] = await this.modelClient.embedTexts([query]);
    if (!queryVector) {
      return;
    }

    const ranked = rows
      .map((row) => ({
        row,
        score: cosineSimilarity(queryVector, row.vector),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.search.semanticCandidateLimit);

    for (const [index, hit] of ranked.entries()) {
      const contribution = 1 / (FUSION_RANK_CONSTANT + index + 1);
      const existing = candidates.find((candidate) => candidate.chunkId === hit.row.chunkId);
      if (existing) {
        existing.score += contribution;
        existing.semanticRank = index + 1;
        continue;
      }

      candidates.push({
        chunkId: hit.row.chunkId,
        documentId: hit.row.documentId,
        title: hit.row.title,
        sourceHtmlUrl: hit.row.sourceHtmlUrl,
        sourceMdUrl: hit.row.sourceMdUrl,
        headingPath: hit.row.headingPath,
        snippet: collapseSnippet(hit.row.content),
        content: hit.row.content,
        chatbotDeprioritize: hit.row.chatbotDeprioritize,
        score: contribution,
        semanticRank: index + 1,
      });
    }
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const requestedLimit = clamp(options.limit, 1, this.config.search.maxLimit);
    const candidates: CandidateAccumulator[] = [];

    if (options.mode !== "semantic") {
      const lexical = this.store.searchLexical(query, {
        ...options,
        limit: Math.max(requestedLimit * 3, this.config.search.rerankTopK),
      });
      this.mergeLexical(candidates, lexical);
    }

    if (options.mode !== "keyword") {
      try {
        await this.mergeSemantic(candidates, query, options);
      } catch {
        if (options.mode === "semantic" && candidates.length === 0) {
          throw new Error("Semantic search is unavailable until model assets are installed locally.");
        }
      }
    }

    candidates.sort((left, right) => right.score - left.score);

    const rerankPool = candidates.slice(0, this.config.search.rerankTopK);
    if (rerankPool.length > 0) {
      try {
        const rerankScores = await this.modelClient.rerank(
          query,
          rerankPool.map((candidate) => `${candidate.title}\n${candidate.headingPath}\n${candidate.content}`),
        );

        for (const [index, score] of rerankScores.entries()) {
          const candidate = rerankPool[index];
          if (!candidate) {
            continue;
          }
          candidate.score += score * 2;
        }
      } catch {
        // Retrieval should stay usable even if reranking cannot load.
      }
    }

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, requestedLimit)
      .map((candidate) => ({
        documentId: candidate.documentId,
        chunkId: candidate.chunkId,
        title: candidate.title,
        sourceHtmlUrl: candidate.sourceHtmlUrl,
        sourceMdUrl: candidate.sourceMdUrl,
        headingPath: candidate.headingPath,
        snippet: candidate.snippet,
        score: candidate.score,
        lexicalRank: candidate.lexicalRank,
        semanticRank: candidate.semanticRank,
        chatbotDeprioritize: candidate.chatbotDeprioritize,
        resourceUri: `docs://page/${candidate.documentId}`,
      }));
  }
}
