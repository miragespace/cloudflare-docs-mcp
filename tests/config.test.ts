import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const createdDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config", () => {
  it("parses allowed hosts from the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudflare-docs-mcp-config-"));
    createdDirs.push(dir);
    vi.stubEnv("CLOUDFLARE_DOCS_MCP_HOST", "0.0.0.0");
    vi.stubEnv("CLOUDFLARE_DOCS_MCP_ALLOWED_HOSTS", "127.0.0.1, localhost, docsbox, 192.168.1.50");

    const config = await loadConfig(dir);

    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.allowedHosts).toEqual([
      "127.0.0.1",
      "localhost",
      "docsbox",
      "192.168.1.50",
    ]);
  });
});
