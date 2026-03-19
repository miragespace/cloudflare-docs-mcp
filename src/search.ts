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
import { clamp, collapseSnippet, cosineSimilarity, normalizeProductFilter } from "./utils.js";

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

interface RankedSemanticCandidate {
  row: EmbeddingRow;
  score: number;
}

export class SearchEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly store: DatabaseStore,
    private readonly modelClient: ModelClient,
  ) {}

  async warmup(): Promise<void> {
    await this.modelClient.warmup();
  }

  async close(): Promise<void> {
    await this.modelClient.close();
  }

  private normalizeOptions(options: SearchOptions): SearchOptions {
    return {
      ...options,
      product: normalizeProductFilter(options.product),
    };
  }

  private insertRankedSemanticCandidate(ranked: RankedSemanticCandidate[], candidate: RankedSemanticCandidate): void {
    const limit = this.config.search.semanticCandidateLimit;
    if (limit <= 0) {
      return;
    }

    const lowest = ranked[ranked.length - 1];
    if (ranked.length >= limit && lowest && candidate.score <= lowest.score) {
      return;
    }

    const insertAt = ranked.findIndex((entry) => candidate.score > entry.score);
    ranked.splice(insertAt === -1 ? ranked.length : insertAt, 0, candidate);

    if (ranked.length > limit) {
      ranked.pop();
    }
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
    const [queryVector] = await this.modelClient.embedTexts([query]);
    if (!queryVector) {
      return;
    }

    const ranked: RankedSemanticCandidate[] = [];
    for (const row of this.store.iterateEmbeddings(options)) {
      this.insertRankedSemanticCandidate(ranked, {
        row,
        score: cosineSimilarity(queryVector, row.vector),
      });
    }

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
    const normalizedOptions = this.normalizeOptions(options);
    const requestedLimit = clamp(options.limit, 1, this.config.search.maxLimit);
    const candidates: CandidateAccumulator[] = [];

    if (normalizedOptions.mode !== "semantic") {
      const lexical = this.store.searchLexical(query, {
        ...normalizedOptions,
        limit: Math.max(requestedLimit * 3, this.config.search.rerankTopK),
      });
      this.mergeLexical(candidates, lexical);
    }

    if (normalizedOptions.mode !== "keyword") {
      try {
        await this.mergeSemantic(candidates, query, normalizedOptions);
      } catch {
        if (normalizedOptions.mode === "semantic" && candidates.length === 0) {
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
