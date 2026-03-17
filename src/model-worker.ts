import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline, TextClassificationPipeline } from "@huggingface/transformers";
import type { ModelRuntimeConfig } from "./types.js";

interface WorkerRequest {
  id: number;
  type: "warmup" | "embed" | "rerank";
  payload?: unknown;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const runtime = workerData as ModelRuntimeConfig;
env.cacheDir = runtime.cacheDir;
env.allowRemoteModels = runtime.allowRemoteModels;
env.allowLocalModels = true;

let embeddingPipelinePromise: Promise<FeatureExtractionPipeline> | undefined;
let rerankerPipelinePromise: Promise<TextClassificationPipeline> | undefined;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = pipeline("feature-extraction", runtime.embeddingModelId, {
      local_files_only: !runtime.allowRemoteModels,
      device: runtime.device,
    }) as Promise<FeatureExtractionPipeline>;
  }

  return embeddingPipelinePromise;
}

async function getRerankerPipeline(): Promise<TextClassificationPipeline> {
  if (!rerankerPipelinePromise) {
    rerankerPipelinePromise = pipeline("text-classification", runtime.rerankerModelId, {
      local_files_only: !runtime.allowRemoteModels,
      device: runtime.device,
    }) as Promise<TextClassificationPipeline>;
  }

  return rerankerPipelinePromise;
}

function tensorToVectors(tensor: { data: Float32Array; dims: number[] }): number[][] {
  const dims = tensor.dims;
  if (dims.length < 2) {
    return [Array.from(tensor.data)];
  }

  const batch = dims[0] ?? 1;
  const width = dims[dims.length - 1] ?? tensor.data.length;
  const vectors: number[][] = [];
  for (let row = 0; row < batch; row += 1) {
    const start = row * width;
    vectors.push(Array.from(tensor.data.slice(start, start + width)));
  }
  return vectors;
}

function positiveScore(result: unknown): number {
  if (!Array.isArray(result)) {
    const single = result as { score?: number } | undefined;
    return typeof single?.score === "number" ? single.score : 0;
  }

  const labels = result as Array<{ label: string; score: number }>;
  const preferred = labels.find((item) => /(relevant|true|positive|label_1|1)/i.test(item.label));
  if (preferred) {
    return preferred.score;
  }
  return labels[0]?.score ?? 0;
}

async function handleRequest(message: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (message.type === "warmup") {
      const embedder = await getEmbeddingPipeline();
      await embedder("warmup", { pooling: "mean", normalize: true });
      const reranker = await getRerankerPipeline();
      await reranker("query: warmup\npassage: warmup", { top_k: 2 });
      return { id: message.id, ok: true, result: true };
    }

    if (message.type === "embed") {
      const texts = (message.payload as string[]) ?? [];
      const embedder = await getEmbeddingPipeline();
      const tensor = await embedder(texts, { pooling: "mean", normalize: true });
      return { id: message.id, ok: true, result: tensorToVectors(tensor as { data: Float32Array; dims: number[] }) };
    }

    if (message.type === "rerank") {
      const payload = message.payload as { query: string; candidates: string[] };
      const reranker = await getRerankerPipeline();
      const outputs = await reranker(
        payload.candidates.map((candidate) => `query: ${payload.query}\npassage: ${candidate}`),
        { top_k: 2 },
      );
      const scores = Array.isArray(outputs)
        ? outputs.map((result) => positiveScore(result))
        : [positiveScore(outputs)];
      return { id: message.id, ok: true, result: scores };
    }

    return { id: message.id, ok: false, error: `Unknown worker request: ${message.type}` };
  } catch (error) {
    return {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

parentPort?.on("message", async (message: WorkerRequest) => {
  const response = await handleRequest(message);
  parentPort?.postMessage(response);
});
