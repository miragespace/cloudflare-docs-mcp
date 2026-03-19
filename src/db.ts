import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ChunkInput,
  DocumentRow,
  EmbeddingRow,
  LexicalCandidate,
  ParsedPage,
  SearchOptions,
  StatusReport,
  SyncRunRecord,
  SyncSummary,
} from "./types.js";
import { normalizeProductFilter, packFloat32, unpackFloat32, urlPathFromHtmlUrl } from "./utils.js";

function createSchema(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      last_updated TEXT,
      chatbot_deprioritize INTEGER NOT NULL,
      tags_json TEXT NOT NULL,
      source_html_url TEXT NOT NULL,
      source_md_url TEXT NOT NULL,
      canonical_url TEXT NOT NULL UNIQUE,
      url_path TEXT NOT NULL,
      markdown TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading_path TEXT NOT NULL,
      content TEXT NOT NULL,
      search_text TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      UNIQUE(document_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      content_hash TEXT NOT NULL,
      downloaded_at TEXT NOT NULL,
      status TEXT NOT NULL,
      document_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      excluded_404_count INTEGER NOT NULL,
      excluded_license_count INTEGER NOT NULL,
      error_message TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      chunk_id UNINDEXED,
      title,
      heading_path,
      url_path,
      content,
      tokenize = 'porter unicode61'
    );

    CREATE INDEX IF NOT EXISTS idx_documents_url_path ON documents(url_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
  `);
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  if (tokens.length === 0) {
    return `"${query.replace(/"/g, '""')}"`;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export class DatabaseStore {
  private readonly db: DatabaseType;
  private readonly insertDocumentStmt: Statement;
  private readonly insertChunkStmt: Statement;
  private readonly insertEmbeddingStmt: Statement;
  private readonly insertFtsStmt: Statement;

  constructor(private readonly dbPath: string, options?: { readonly?: boolean }) {
    if (!options?.readonly) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, options?.readonly ? { readonly: true } : {});
    createSchema(this.db);
    this.insertDocumentStmt = this.db.prepare(`
      INSERT INTO documents (
        title, description, last_updated, chatbot_deprioritize, tags_json,
        source_html_url, source_md_url, canonical_url, url_path, markdown
      ) VALUES (
        @title, @description, @lastUpdated, @chatbotDeprioritize, @tagsJson,
        @sourceHtmlUrl, @sourceMdUrl, @canonicalUrl, @urlPath, @markdown
      )
    `);
    this.insertChunkStmt = this.db.prepare(`
      INSERT INTO chunks (
        document_id, chunk_index, heading_path, content, search_text, char_count
      ) VALUES (
        @documentId, @chunkIndex, @headingPath, @content, @searchText, @charCount
      )
    `);
    this.insertEmbeddingStmt = this.db.prepare(`
      INSERT INTO embeddings (chunk_id, model_id, dimensions, vector)
      VALUES (@chunkId, @modelId, @dimensions, @vector)
    `);
    this.insertFtsStmt = this.db.prepare(`
      INSERT INTO chunk_fts (chunk_id, title, heading_path, url_path, content)
      VALUES (@chunkId, @title, @headingPath, @urlPath, @content)
    `);
  }

  close(): void {
    this.db.close();
  }

  getLatestSync(): SyncRunRecord | undefined {
    const row = this.db.prepare(`
      SELECT
        id, source_url, etag, last_modified, content_hash,
        downloaded_at, status, document_count, chunk_count,
        excluded_404_count, excluded_license_count, error_message
      FROM sync_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as
      | {
          id: number;
          source_url: string;
          etag: string | null;
          last_modified: string | null;
          content_hash: string;
          downloaded_at: string;
          status: string;
          document_count: number;
          chunk_count: number;
          excluded_404_count: number;
          excluded_license_count: number;
          error_message: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      sourceUrl: row.source_url,
      etag: row.etag,
      lastModified: row.last_modified,
      contentHash: row.content_hash,
      downloadedAt: row.downloaded_at,
      status: row.status,
      documentCount: row.document_count,
      chunkCount: row.chunk_count,
      excluded404Count: row.excluded_404_count,
      excludedLicenseCount: row.excluded_license_count,
      errorMessage: row.error_message,
    };
  }

  insertPage(page: ParsedPage, chunks: ChunkInput[]): number[] {
    const info = this.insertDocumentStmt.run({
      title: page.title,
      description: page.description ?? null,
      lastUpdated: page.lastUpdated ?? null,
      chatbotDeprioritize: page.chatbotDeprioritize ? 1 : 0,
      tagsJson: JSON.stringify(page.tags),
      sourceHtmlUrl: page.sourceUrl.html,
      sourceMdUrl: page.sourceUrl.md,
      canonicalUrl: page.sourceUrl.html,
      urlPath: urlPathFromHtmlUrl(page.sourceUrl.html),
      markdown: page.rawPage,
    });
    const documentId = Number(info.lastInsertRowid);
    const chunkIds: number[] = [];
    const urlPath = urlPathFromHtmlUrl(page.sourceUrl.html);

    const transaction = this.db.transaction(() => {
      for (const chunk of chunks) {
        const chunkInfo = this.insertChunkStmt.run({
          documentId,
          chunkIndex: chunk.chunkIndex,
          headingPath: chunk.headingPath,
          content: chunk.content,
          searchText: chunk.searchText,
          charCount: chunk.charCount,
        });
        const chunkId = Number(chunkInfo.lastInsertRowid);
        chunkIds.push(chunkId);
        this.insertFtsStmt.run({
          chunkId,
          title: page.title,
          headingPath: chunk.headingPath,
          urlPath,
          content: chunk.searchText,
        });
      }
    });

    transaction();
    return chunkIds;
  }

  insertEmbeddings(chunkIds: number[], vectors: Float32Array[], modelId: string): void {
    const transaction = this.db.transaction(() => {
      for (const [index, chunkId] of chunkIds.entries()) {
        const vector = vectors[index];
        if (!vector) {
          continue;
        }

        this.insertEmbeddingStmt.run({
          chunkId,
          modelId,
          dimensions: vector.length,
          vector: packFloat32(vector),
        });
      }
    });

    transaction();
  }

  appendSyncRun(summary: SyncSummary, status: "success" | "not_modified" | "failed", errorMessage: string | null = null): void {
    this.db.prepare(`
      INSERT INTO sync_runs (
        source_url, etag, last_modified, content_hash, downloaded_at,
        status, document_count, chunk_count, excluded_404_count,
        excluded_license_count, error_message
      ) VALUES (
        @sourceUrl, @etag, @lastModified, @contentHash, @downloadedAt,
        @status, @documentCount, @chunkCount, @excluded404Count,
        @excludedLicenseCount, @errorMessage
      )
    `).run({
      sourceUrl: summary.sourceUrl,
      etag: summary.etag,
      lastModified: summary.lastModified,
      contentHash: summary.contentHash,
      downloadedAt: summary.downloadedAt,
      status,
      documentCount: summary.storedDocuments,
      chunkCount: summary.storedChunks,
      excluded404Count: summary.excluded404Count,
      excludedLicenseCount: summary.excludedLicenseCount,
      errorMessage,
    });
  }

  getStatus(dbPath: string, corpusPath: string): StatusReport {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM documents) AS document_count,
        (SELECT COUNT(*) FROM chunks) AS chunk_count,
        (SELECT COUNT(*) FROM embeddings) AS embedding_count
    `).get() as {
      document_count: number;
      chunk_count: number;
      embedding_count: number;
    };

    return {
      databaseReady: counts.document_count > 0,
      dbPath,
      corpusPath,
      documentCount: counts.document_count,
      chunkCount: counts.chunk_count,
      embeddingCount: counts.embedding_count,
      lastSync: this.getLatestSync(),
    };
  }

  getDocumentByIdOrUrl(identifier: { docId?: number | undefined; url?: string | undefined }): DocumentRow | undefined {
    const row = this.db.prepare(`
      SELECT
        id,
        title,
        description,
        last_updated,
        chatbot_deprioritize,
        tags_json,
        source_html_url,
        source_md_url,
        canonical_url,
        url_path,
        markdown
      FROM documents
      WHERE
        (@docId IS NOT NULL AND id = @docId)
        OR (@url IS NOT NULL AND canonical_url = @url)
      LIMIT 1
    `).get({
      docId: identifier.docId ?? null,
      url: identifier.url ?? null,
    }) as
      | {
          id: number;
          title: string;
          description: string | null;
          last_updated: string | null;
          chatbot_deprioritize: number;
          tags_json: string;
          source_html_url: string;
          source_md_url: string;
          canonical_url: string;
          url_path: string;
          markdown: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      lastUpdated: row.last_updated,
      chatbotDeprioritize: row.chatbot_deprioritize === 1,
      tags: JSON.parse(row.tags_json) as string[],
      sourceHtmlUrl: row.source_html_url,
      sourceMdUrl: row.source_md_url,
      canonicalUrl: row.canonical_url,
      urlPath: row.url_path,
      markdown: row.markdown,
    };
  }

  searchLexical(query: string, options: SearchOptions): LexicalCandidate[] {
    const product = normalizeProductFilter(options.product);
    const rows = this.db.prepare(`
      SELECT
        c.id AS chunk_id,
        d.id AS document_id,
        d.title AS title,
        d.source_html_url AS source_html_url,
        d.source_md_url AS source_md_url,
        d.chatbot_deprioritize AS chatbot_deprioritize,
        c.heading_path AS heading_path,
        c.content AS content,
        snippet(chunk_fts, 4, '', '', ' … ', 20) AS snippet,
        bm25(chunk_fts, 10.0, 5.0, 3.0, 1.0) AS lexical_score
      FROM chunk_fts
      JOIN chunks c ON c.id = CAST(chunk_fts.chunk_id AS INTEGER)
      JOIN documents d ON d.id = c.document_id
      WHERE chunk_fts MATCH @ftsQuery
        AND (@product IS NULL OR d.url_path LIKE @productPattern)
        AND (@includeDeprioritized = 1 OR d.chatbot_deprioritize = 0)
      ORDER BY lexical_score ASC
      LIMIT @limit
    `).all({
      ftsQuery: toFtsQuery(query),
      product: product ?? null,
      productPattern: product ? `/${product}/%` : null,
      includeDeprioritized: options.includeDeprioritized ? 1 : 0,
      limit: options.limit,
    }) as Array<{
      chunk_id: number;
      document_id: number;
      title: string;
      source_html_url: string;
      source_md_url: string;
      chatbot_deprioritize: number;
      heading_path: string;
      content: string;
      snippet: string | null;
      lexical_score: number;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      sourceHtmlUrl: row.source_html_url,
      sourceMdUrl: row.source_md_url,
      chatbotDeprioritize: row.chatbot_deprioritize === 1,
      headingPath: row.heading_path,
      content: row.content,
      snippet: row.snippet ?? row.content,
      lexicalScore: Number.isFinite(row.lexical_score) ? -row.lexical_score : 0,
    }));
  }

  *iterateEmbeddings(options: Pick<SearchOptions, "product" | "includeDeprioritized">): IterableIterator<EmbeddingRow> {
    const product = normalizeProductFilter(options.product);
    const rows = this.db.prepare(`
      SELECT
        e.chunk_id AS chunk_id,
        c.document_id AS document_id,
        d.title AS title,
        d.source_html_url AS source_html_url,
        d.source_md_url AS source_md_url,
        d.chatbot_deprioritize AS chatbot_deprioritize,
        c.heading_path AS heading_path,
        c.content AS content,
        e.vector AS vector
      FROM embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE (@product IS NULL OR d.url_path LIKE @productPattern)
        AND (@includeDeprioritized = 1 OR d.chatbot_deprioritize = 0)
      ORDER BY e.chunk_id ASC
    `).iterate({
      product: product ?? null,
      productPattern: product ? `/${product}/%` : null,
      includeDeprioritized: options.includeDeprioritized ? 1 : 0,
    }) as IterableIterator<{
      chunk_id: number;
      document_id: number;
      title: string;
      source_html_url: string;
      source_md_url: string;
      chatbot_deprioritize: number;
      heading_path: string;
      content: string;
      vector: Buffer;
    }>;

    for (const row of rows) {
      yield {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        sourceHtmlUrl: row.source_html_url,
        sourceMdUrl: row.source_md_url,
        chatbotDeprioritize: row.chatbot_deprioritize === 1,
        headingPath: row.heading_path,
        content: row.content,
        vector: unpackFloat32(row.vector),
      };
    }
  }
}
