import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import matter from "gray-matter";
import { PAGE_CLOSE, PAGE_OPEN, TITLE_404_PREFIX, TITLE_LICENSE_PREFIX } from "./constants.js";
import type { ParsedPage } from "./types.js";

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function coerceTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim() !== "") {
    return [value];
  }

  return [];
}

export function isExcludedTitle(title: string): { excluded: boolean; reason?: "404" | "license" } {
  if (title.startsWith(TITLE_404_PREFIX)) {
    return { excluded: true, reason: "404" };
  }

  if (title.startsWith(TITLE_LICENSE_PREFIX)) {
    return { excluded: true, reason: "license" };
  }

  return { excluded: false };
}

export function parsePage(rawPage: string): ParsedPage {
  const parsed = matter(rawPage);
  const sourceUrl = parsed.data.source_url;
  const title = coerceString(parsed.data.title);
  const htmlUrl = coerceString((sourceUrl as { html?: unknown } | undefined)?.html);
  const mdUrl = coerceString((sourceUrl as { md?: unknown } | undefined)?.md);

  if (!title || !htmlUrl || !mdUrl) {
    throw new Error("Corpus page is missing required metadata");
  }

  return {
    rawPage,
    markdownBody: parsed.content.trim(),
    title,
    description: coerceString(parsed.data.description),
    lastUpdated: coerceString(parsed.data.lastUpdated),
    chatbotDeprioritize: parsed.data.chatbotDeprioritize === true,
    tags: coerceTags(parsed.data.tags),
    sourceUrl: {
      html: htmlUrl,
      md: mdUrl,
    },
  };
}

export async function parseCorpusFile(
  filePath: string,
  onPage: (page: ParsedPage) => Promise<void> | void,
): Promise<number> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });

  let insidePage = false;
  let lines: string[] = [];
  let pageCount = 0;

  for await (const line of reader) {
    if (line === PAGE_OPEN) {
      insidePage = true;
      lines = [];
      continue;
    }

    if (line === PAGE_CLOSE) {
      if (insidePage) {
        pageCount += 1;
        await onPage(parsePage(`${lines.join("\n")}\n`));
      }

      insidePage = false;
      lines = [];
      continue;
    }

    if (insidePage) {
      lines.push(line);
    }
  }

  return pageCount;
}
