import { describe, expect, it } from "vitest";
import { embedTextsBatched } from "../src/sync.js";
import type { ModelClient } from "../src/types.js";

class RecordingModelClient implements ModelClient {
  readonly calls: string[][] = [];

  async warmup(): Promise<void> {}

  async close(): Promise<void> {}

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((text, index) => Float32Array.from([text.length, index]));
  }

  async rerank(): Promise<number[]> {
    return [];
  }
}

describe("embedTextsBatched", () => {
  it("splits embedding requests into bounded batches while preserving order", async () => {
    const modelClient = new RecordingModelClient();
    const texts = ["alpha", "beta", "gamma", "delta", "epsilon"];

    const vectors = await embedTextsBatched(modelClient, texts, 2);

    expect(modelClient.calls).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
      ["epsilon"],
    ]);
    expect(vectors).toEqual([
      Float32Array.from([5, 0]),
      Float32Array.from([4, 1]),
      Float32Array.from([5, 0]),
      Float32Array.from([5, 1]),
      Float32Array.from([7, 0]),
    ]);
  });
});
