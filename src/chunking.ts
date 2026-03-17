import type { ChunkInput, ParsedPage } from "./types.js";
import { collapseSnippet, normalizeWhitespace } from "./utils.js";

interface Section {
  headingPath: string;
  contentLines: string[];
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match?.[1] ? match[1].length : null;
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function splitLargeSection(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) {
    return [content.trim()];
  }

  const paragraphs = content.split(/\n{2,}/);
  const parts: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current !== "") {
      parts.push(current.trim());
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    for (let start = 0; start < paragraph.length; start += maxChars) {
      parts.push(paragraph.slice(start, start + maxChars).trim());
    }

    current = "";
  }

  if (current !== "") {
    parts.push(current.trim());
  }

  return parts.filter(Boolean);
}

export function chunkPage(page: ParsedPage, maxChars: number): ChunkInput[] {
  const lines = page.markdownBody.split("\n");
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let current: Section = {
    headingPath: page.title,
    contentLines: [],
  };

  for (const line of lines) {
    const level = headingLevel(line);
    if (level !== null) {
      if (current.contentLines.length > 0) {
        sections.push(current);
      }
      headingStack.length = Math.max(0, level - 1);
      headingStack[level - 1] = headingText(line);
      current = {
        headingPath: [page.title, ...headingStack.filter(Boolean)].join(" / "),
        contentLines: [line],
      };
      continue;
    }

    current.contentLines.push(line);
  }

  if (current.contentLines.length > 0) {
    sections.push(current);
  }

  const chunks: ChunkInput[] = [];

  for (const section of sections) {
    const sectionText = section.contentLines.join("\n").trim();
    if (!sectionText) {
      continue;
    }

    for (const content of splitLargeSection(sectionText, maxChars)) {
      const searchText = normalizeWhitespace([page.title, section.headingPath, content].join("\n"));
      chunks.push({
        chunkIndex: chunks.length,
        headingPath: section.headingPath,
        content,
        searchText,
        charCount: content.length,
      });
    }
  }

  if (chunks.length === 0) {
    const fallback = page.markdownBody.trim() || page.description || page.title;
    const searchText = normalizeWhitespace([page.title, fallback].join("\n"));
    chunks.push({
      chunkIndex: 0,
      headingPath: page.title,
      content: collapseSnippet(fallback, maxChars),
      searchText,
      charCount: fallback.length,
    });
  }

  return chunks;
}
