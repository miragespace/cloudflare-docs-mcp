import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import type { AppConfig } from "./types.js";
import { SearchEngine } from "./search.js";
import { createDocsMcpServer } from "./mcp-server.js";

function logHttpRequest(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const host = req.headers.host ?? "<missing-host>";
    console.log(
      `[${new Date().toISOString()}] HTTP ${req.method} ${req.originalUrl} host=${host} status=${res.statusCode} durationMs=${durationMs}`,
    );
  });
  next();
}

export async function startHttpServer(config: AppConfig, searchEngine: SearchEngine): Promise<HttpServer> {
  const app = createMcpExpressApp({
    host: config.server.host,
    ...(config.server.allowedHosts ? { allowedHosts: config.server.allowedHosts } : {}),
  });
  app.use(logHttpRequest);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      status: searchEngine.getStatus(),
    });
  });

  app.get("/status", (_req, res) => {
    res.json(searchEngine.getStatus());
  });

  app.post(config.server.mcpPath, async (req, res) => {
    const server = createDocsMcpServer(config, searchEngine);

    try {
      const transport = new StreamableHTTPServerTransport();
      await server.connect(transport as any);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get(config.server.mcpPath, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  app.delete(config.server.mcpPath, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });

  return new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.server.port, config.server.host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(server);
    });
  });
}
