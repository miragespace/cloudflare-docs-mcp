import { createHash } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function packFloat32(values: Float32Array): Buffer {
  return Buffer.from(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength));
}

export function unpackFloat32(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return new Float32Array(arrayBuffer);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function urlPathFromHtmlUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function normalizeProductFilter(product?: string): string | undefined {
  if (!product) {
    return undefined;
  }

  const normalized = product.trim().replace(/^\/+|\/+$/g, "");
  return normalized === "" ? undefined : normalized;
}

export function collapseSnippet(text: string, maxLength = 280): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    dot += aValue * bValue;
    aNorm += aValue * aValue;
    bNorm += bValue * bValue;
  }

  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }

  return dot / Math.sqrt(aNorm * bNorm);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}
