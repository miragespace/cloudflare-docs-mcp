import { Worker } from "node:worker_threads";
import type { ModelClient, ModelRuntimeConfig } from "./types.js";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function workerUrl(): URL {
  const currentUrl = new URL(import.meta.url);
  return currentUrl.pathname.endsWith(".ts")
    ? new URL("./model-worker.ts", import.meta.url)
    : new URL("./model-worker.js", import.meta.url);
}

export class TransformersWorkerModelClient implements ModelClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private exitError: Error | undefined;

  constructor(runtime: ModelRuntimeConfig) {
    this.worker = new Worker(workerUrl(), {
      workerData: runtime,
      execArgv: process.execArgv,
    });
    this.worker.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error ?? "Model worker request failed"));
      }
    });
    this.worker.on("error", (error) => {
      this.rejectAll(error);
    });
    this.worker.on("exit", (code) => {
      if (code === 0) {
        return;
      }

      const error = new Error(
        `Model worker exited unexpectedly with code ${code}. This usually means the selected runtime/device failed during native model initialization.`,
      );
      this.exitError = error;
      this.rejectAll(error);
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(type: "warmup" | "embed" | "rerank", payload?: unknown): Promise<T> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for model worker response during ${type}.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async warmup(): Promise<void> {
    await this.request("warmup");
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.request<number[][]>("embed", texts);
    return vectors.map((vector) => Float32Array.from(vector));
  }

  async rerank(query: string, candidates: string[]): Promise<number[]> {
    return this.request<number[]>("rerank", { query, candidates });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}
