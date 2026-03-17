import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { APP_NAME, APP_VERSION } from "./constants.js";
import type { AppConfig } from "./types.js";
import { SearchEngine } from "./search.js";

function renderSearchResults(results: Awaited<ReturnType<SearchEngine["search"]>>): string {
  if (results.length === 0) {
    return "No Cloudflare docs matched the query.";
  }

  return results
    .map((result, index) => {
      const parts = [
        `${index + 1}. ${result.title}`,
        result.headingPath !== result.title ? `Heading: ${result.headingPath}` : undefined,
        `URL: ${result.sourceHtmlUrl}`,
        `Snippet: ${result.snippet}`,
        `Resource: ${result.resourceUri}`,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");
}

export function createDocsMcpServer(config: AppConfig, searchEngine: SearchEngine): McpServer {
  const server = new McpServer(
    {
      name: APP_NAME,
      version: APP_VERSION,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "search_cloudflare_docs",
    {
      description: "Search the local Cloudflare documentation index with hybrid, keyword, or semantic retrieval.",
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
        limit: z.number().int().positive().max(config.search.maxLimit).default(config.search.defaultLimit),
        product: z.string().optional(),
        includeDeprioritized: z.boolean().default(false),
      },
    },
    async ({ query, mode, limit, product, includeDeprioritized }) => {
      const options = product
        ? { mode, limit, product, includeDeprioritized }
        : { mode, limit, includeDeprioritized };
      const results = await searchEngine.search(query, options);

      return {
        content: [
          {
            type: "text",
            text: renderSearchResults(results),
          },
        ],
        structuredContent: {
          results,
        },
      };
    },
  );

  server.registerTool(
    "get_cloudflare_doc_markdown",
    {
      description: "Fetch the exact stored markdown for a Cloudflare docs page by document id or canonical URL.",
      inputSchema: {
        docId: z.number().int().positive().optional(),
        url: z.string().url().optional(),
      },
    },
    async ({ docId, url }) => {
      if (!docId && !url) {
        throw new Error("Provide either docId or url.");
      }

      const identifier = docId ? { docId } : { url };
      const document = searchEngine.getDocument(identifier);

      if (!document) {
        return {
          content: [
            {
              type: "text",
              text: "Document not found.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: document.markdown,
          },
        ],
        structuredContent: {
          document,
        },
      };
    },
  );

  server.registerPrompt(
    "use-cloudflare-docs-first",
    {
      description: "Prompt template reminding agents to consult this local Cloudflare docs MCP before relying on stale knowledge.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use the local Cloudflare docs MCP tools first for Cloudflare-specific questions.",
              "Prefer `search_cloudflare_docs` for current product knowledge, exact flags, paths, APIs, and error strings.",
              "Fetch full markdown only when the search result snippet is insufficient.",
            ].join(" "),
          },
        },
      ],
    }),
  );

  server.registerResource(
    "cloudflare-doc-page",
    new ResourceTemplate("docs://page/{docId}", { list: undefined }),
    {
      mimeType: "text/markdown",
      description: "Stored Cloudflare documentation page as markdown.",
    },
    async (_uri, variables) => {
      const docIdValue = variables.docId;
      const docId = Number(docIdValue);
      if (!Number.isFinite(docId)) {
        throw new Error(`Invalid document id: ${docIdValue}`);
      }

      const document = searchEngine.getDocument({ docId });
      if (!document) {
        throw new Error(`Document ${docId} was not found.`);
      }

      return {
        contents: [
          {
            uri: `docs://page/${docId}`,
            mimeType: "text/markdown",
            text: document.markdown,
          },
        ],
      };
    },
  );

  return server;
}
