Goal:
Implement an MCP server to query Cloudflare developer docs (https://developers.cloudflare.com/) with better LLM agents ergonomics

Rationale:
0. LLM models knowledge is often outdated.
1. Cloudflare docs page is hard to search by an agent (usually involving 1 request to Google, another request to fetch the page).
2. Direct webpage fetching by an agent is unreliable due to networking, firewall, WAF, different tooling's handling of HTML, etc.
3. The root [llms-full.txt](https://developers.cloudflare.com/llms-full.txt) already contains full llms.txt for every product (53 megabytes)
4. `llms-full.txt` already has well-defined boundary `<page> content </page>` to split into different documents with original markdown

Product Requirements:
1. The MCP server must work without reliable internet access once setup
2. The MCP server should be available over HTTP transport only to be used by multiple local agents
3. MCP should expose tools to search by keywords or concepts
4. Preserve original markdown format if requested explictly by the agent
5. When the MCP server is configured, prompt the agent to use this MCP server first for latest knowledge retrieval
6. Answer generation is optional and should require a separate setup
7. Answer generation should degrade gracefully to retrieval only
8. Include manual sync to keep the local knowledge updated

Engineering Requirements:
1. Language must be TypeScript with strict typing
2. Use nodejs worker threads where appropriate
3. Use `better-sqlite3
4. When a dependency is introduced, must use a mature/well-maintained library, preferably with recent commits

Other notes:
1. By default, use the following models (and their GGUF variants if possible, q4_K_M as default, with optional q5_K_M):
    jinaai/jina-embeddings-v2-base-code for retrieval
    Xenova/ms-marco-MiniLM-L-6-v2 for reranking (only top 10)
    optional Qwen/Qwen2.5-Coder-3B-Instruct-GGUF via node-llama-cpp for answer generation
2. Include explanation of aforementioned to the user as part of their setup.
3. Latency tip - Keep retrieved context tight.
    - Don’t stuff huge contexts into the 3B model on CPU.
    - Good retrieval + small context beats weak retrieval + huge context.
4. Retrieval tip - Add lexical search.
    For developer docs, dense retrieval alone often misses:
        - exact symbol names
        - error strings
        - CLI flags
        - file paths
    Dense + BM25/keyword is usually better than a bigger embedding model alone.