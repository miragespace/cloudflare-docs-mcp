# cloudflare-docs-mcp

Local-first MCP server for Cloudflare developer documentation.

It downloads the latest `https://developers.cloudflare.com/llms-full.txt`, builds a local SQLite index, and serves Cloudflare docs search over MCP Streamable HTTP for multiple local agents.

## What It Does

- Downloads and indexes the latest Cloudflare docs corpus during `setup` and `sync`
- Works offline for retrieval after setup completes
- Exposes Cloudflare docs search over HTTP-only MCP
- Preserves original markdown for stored pages
- Combines lexical search and semantic retrieval
- Excludes `404 - Page Not Found*` and `Third party licenses*` pages entirely

## Current Scope

Implemented:

- Remote corpus sync from Cloudflare
- Local SQLite storage with FTS5
- Chunked document indexing
- MCP tools for search and markdown fetch
- MCP resource for page markdown
- Prompt telling agents to use this server first

Not implemented yet:

- Local answer generation
- Legacy SSE transport compatibility
- Client-specific auto-install flows

## Requirements

- Node.js 24+
- npm
- Internet access for the initial `setup` and future `sync`
- Enough disk space for:
  - the downloaded docs corpus
  - the SQLite index
  - local Hugging Face model cache

## Install

```bash
npm install
```

## Docker

For a separate GPU box, this repo now includes a CUDA-focused Docker image and Compose example:

```bash
docker compose -f docker-compose.cuda.yml up --build -d
```

What this does:

- builds a CUDA 12 / Node 24 image from [`Dockerfile.cuda`](/home/rachel/code/cloudflare-docs-mcp/Dockerfile.cuda)
- persists the SQLite index and model cache in `./data`
- binds the MCP server to `0.0.0.0:8787` for LAN access
- auto-runs `setup` on first start before serving

Requirements on the remote machine:

- Docker Engine
- Docker Compose
- NVIDIA Container Toolkit
- a working NVIDIA driver on the host

Useful commands:

```bash
docker compose -f docker-compose.cuda.yml logs -f
docker compose -f docker-compose.cuda.yml exec cloudflare-docs-mcp npm run devices
docker compose -f docker-compose.cuda.yml exec cloudflare-docs-mcp npm run status
docker compose -f docker-compose.cuda.yml run --rm cloudflare-docs-mcp sync
```

Default LAN URL:

```text
http://SERVER_IP:8787/mcp
```

Health check:

```text
http://SERVER_IP:8787/healthz
```

### LAN Safety

This server has no auth. If you bind it to `0.0.0.0`, keep it on a trusted LAN or VPN.

If you want Host-header protection while exposing it on your LAN, set `CLOUDFLARE_DOCS_MCP_ALLOWED_HOSTS` in [`docker-compose.cuda.yml`](/home/rachel/code/cloudflare-docs-mcp/docker-compose.cuda.yml) to the IPs or DNS names clients will use, for example:

```text
127.0.0.1,localhost,192.168.1.50,docsbox
```

## Commands

### Setup

Downloads the latest corpus, warms model assets, and builds the local index.

```bash
npm run setup
```

To explicitly prefer GPU-backed execution providers during setup:

```bash
npm run setup -- --device gpu
```

To explicitly require CUDA:

```bash
npm run setup -- --device cuda
```

### Sync

Refreshes the local index from the latest remote `llms-full.txt`.

```bash
npm run sync
```

You can also override the model device during sync:

```bash
npm run sync -- --device gpu
```

### Status

Shows local DB/index status and last sync metadata.

```bash
npm run status
```

### Devices

Shows which model devices this local runtime can target, the current configured device, which ONNX Runtime backends the package reports, and which GPU provider libraries are actually installed on disk.

```bash
npm run devices
```

### Serve

Starts the local MCP server.

```bash
npm run serve
```

To serve using a different device than the configured default:

```bash
npm run serve -- --device gpu
```

Default endpoint:

```text
http://127.0.0.1:8787/mcp
```

Health endpoint:

```text
http://127.0.0.1:8787/healthz
```

## Client Setup

Start the local MCP server first:

```bash
npm run serve
```

Default server URL:

```text
http://127.0.0.1:8787/mcp
```

### Codex

Add the server from the CLI:

```bash
codex mcp add cloudflareDocs --url http://127.0.0.1:8787/mcp
```

Or add it manually in `~/.codex/config.toml`:

```toml
[mcp_servers.cloudflareDocs]
url = "http://127.0.0.1:8787/mcp"
```

### Windsurf

Add the server to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "cloudflareDocs": {
      "serverUrl": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

### Claude Code

Add the server from the CLI:

```bash
claude mcp add --transport http --scope user cloudflareDocs http://127.0.0.1:8787/mcp
```

Or add it in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "cloudflareDocs": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

### Agent Behavior

Whichever client you use, add an instruction telling the agent to consult this MCP server first for Cloudflare documentation lookups.

## MCP Surface

### Tool: `search_cloudflare_docs`

Inputs:

- `query`
- `mode`: `hybrid | keyword | semantic`
- `limit`
- `product` optional product/path filter
- `includeDeprioritized`

Returns ranked results with:

- title
- source URLs
- heading path
- snippet
- ranking info
- resource URI

### Tool: `get_cloudflare_doc_markdown`

Inputs:

- `docId` or
- `url`

Returns the exact stored markdown payload for the page.

### Resource: `docs://page/{docId}`

Returns the stored markdown for a page.

### Prompt: `use-cloudflare-docs-first`

Reminds agents to use this MCP server before relying on built-in Cloudflare knowledge.

## Search Design

Search is retrieval-first:

- Lexical search: SQLite FTS5 / BM25
- Semantic search: local embeddings
- Fusion: lexical + semantic candidate merge
- Rerank: top candidates reranked locally

The default model configuration is:

- Embeddings: `jinaai/jina-embeddings-v2-base-code`
- Reranker: `Xenova/ms-marco-MiniLM-L-6-v2`
- Device: `cpu`

### Device Selection

Model execution now supports an explicit device setting.

Supported values:

- `cpu`
- `gpu`
- `cuda`
- `auto`
- `wasm`
- `webgpu`
- `dml`
- `webnn`
- `webnn-npu`
- `webnn-gpu`
- `webnn-cpu`

For this Node.js project, the practical choices are usually:

- `cpu` for the default, predictable path
- `gpu` to prefer a GPU execution provider when one is available
- `cuda` to explicitly require CUDA on Linux x64

Important:

- `gpu` is an alias. In Node.js it maps to whichever GPU providers the local runtime exposes.
- A device may be selectable by platform but still fail at warmup if the necessary ONNX Runtime GPU binaries are not installed.
- `onnxRuntimeBackends` reflects package metadata. `installedProviders` reflects the provider `.so` files that are actually present in `node_modules/onnxruntime-node`.
- `setup` and `sync` validate the selected device during model warmup and fail early if the choice is not usable.

### CUDA Setup

For Linux x64 with CUDA 12, install the ONNX Runtime CUDA provider bundle with:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=v12 npm rebuild onnxruntime-node
```

After that, confirm the local runtime sees the provider:

```bash
npm run devices
```

Look for `"installedProviders": ["cuda", ...]`.

If CUDA warmup still fails after that, the usual remaining issue is system library loading. On this machine, the runtime needed `LD_LIBRARY_PATH` to include the CUDA and cuDNN library directories, for example:

```bash
export LD_LIBRARY_PATH=/usr/local/cuda-13.2/targets/x86_64-linux/lib:/usr/local/cuda-12.2/lib64:$LD_LIBRARY_PATH
```

Then rerun:

```bash
npm run setup -- --device cuda
```

If indexing still crashes on a smaller GPU, lower `search.embeddingBatchSize` in `cloudflare-docs-mcp.config.json`. Setup now embeds document chunks in batches instead of sending a whole page at once, and a smaller batch size reduces VRAM pressure during indexing.

## Configuration

Configuration is loaded from:

```text
cloudflare-docs-mcp.config.json
```

Supported top-level sections:

- `server`
- `storage`
- `corpus`
- `models`
- `search`

Example:

```json
{
  "search": {
    "embeddingBatchSize": 4
  },
  "models": {
    "device": "cpu",
    "embeddingModelId": "jinaai/jina-embeddings-v2-base-code",
    "rerankerModelId": "Xenova/ms-marco-MiniLM-L-6-v2"
  }
}
```

Useful environment overrides:

- `CLOUDFLARE_DOCS_MCP_CONFIG`
- `CLOUDFLARE_DOCS_MCP_HOST`
- `CLOUDFLARE_DOCS_MCP_PORT`
- `CLOUDFLARE_DOCS_MCP_DATA_DIR`
- `CLOUDFLARE_DOCS_MCP_MODEL_DEVICE`

Example:

```bash
CLOUDFLARE_DOCS_MCP_MODEL_DEVICE=gpu npm run setup
```

## Development

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

Run CLI directly in dev:

```bash
npm run dev -- --help
```

## Notes

- `serve` requires an existing local index. Run `npm run setup` first.
- After setup, retrieval does not require internet access.
- If model assets are not present locally, semantic retrieval and reranking depend on setup having downloaded them already.
- `npm run devices` is the quickest way to see whether this machine exposes `cpu`, `cuda`, or another target before running setup.
- `setup` reuses `data/llms-full.txt.download` or `data/llms-full.txt` if one is already present, so repeated runs do not require re-downloading the corpus first.
- The checked-in `llms-full.txt` file is only local reference material for development. Runtime setup and sync fetch the latest copy from Cloudflare.
