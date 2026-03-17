import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExcludedTitle, parseCorpusFile, parsePage } from "../src/parser.js";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parser", () => {
  it("parses a page and preserves the markdown payload", () => {
    const rawPage = `---
title: Durable Objects · Cloudflare Workers docs
description: Stateful coordination for Workers.
lastUpdated: 2026-03-01T00:00:00.000Z
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/durable-objects/
  md: https://developers.cloudflare.com/durable-objects/index.md
---

# Durable Objects

Durable Objects provide stateful coordination.`;

    const page = parsePage(`${rawPage}\n`);
    expect(page.title).toBe("Durable Objects · Cloudflare Workers docs");
    expect(page.description).toBe("Stateful coordination for Workers.");
    expect(page.sourceUrl.html).toBe("https://developers.cloudflare.com/durable-objects/");
    expect(page.rawPage).toContain("# Durable Objects");
    expect(page.markdownBody).toContain("Durable Objects provide stateful coordination.");
  });

  it("flags excluded titles and iterates pages from a corpus file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloudflare-docs-mcp-parser-"));
    createdDirs.push(dir);
    const corpusPath = join(dir, "fixture.txt");
    await writeFile(
      corpusPath,
      `<page>
---
title: 404 - Page Not Found | Cloudflare Docs
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/404/
  md: https://developers.cloudflare.com/404/index.md
---

missing
</page>
<page>
---
title: Browser Rendering · Cloudflare Browser Rendering docs
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/browser-rendering/
  md: https://developers.cloudflare.com/browser-rendering/index.md
---

Useful page
</page>
`,
      "utf8",
    );

    const titles: string[] = [];
    const count = await parseCorpusFile(corpusPath, async (page) => {
      titles.push(page.title);
    });

    expect(count).toBe(2);
    expect(titles).toEqual([
      "404 - Page Not Found | Cloudflare Docs",
      "Browser Rendering · Cloudflare Browser Rendering docs",
    ]);
    expect(isExcludedTitle(titles[0] ?? "")).toEqual({ excluded: true, reason: "404" });
    expect(isExcludedTitle("Third party licenses · Cloudflare WAN docs")).toEqual({
      excluded: true,
      reason: "license",
    });
    expect(isExcludedTitle(titles[1] ?? "")).toEqual({ excluded: false });
  });
});
