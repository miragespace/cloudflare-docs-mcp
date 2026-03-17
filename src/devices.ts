import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import onnxRuntime from "onnxruntime-node";
import type { ModelDevice } from "./types.js";

const require = createRequire(import.meta.url);

export interface DeviceReport {
  configuredDevice: ModelDevice;
  selectableDevices: ModelDevice[];
  gpuAliasTargets: ModelDevice[];
  defaultDevice: ModelDevice;
  onnxRuntimeBackends: Array<{ name: string; bundled: boolean }>;
  installedProviders: string[];
  recommendations: string[];
  notes: string[];
}

function installedProviders(): string[] {
  const packageEntry = require.resolve("onnxruntime-node");
  const binDir = join(dirname(packageEntry), "..", "bin", "napi-v3", process.platform, process.arch);
  const providers: string[] = [];

  const providerFiles = [
    { name: "cuda", filename: process.platform === "win32" ? "onnxruntime_providers_cuda.dll" : "libonnxruntime_providers_cuda.so" },
    { name: "tensorrt", filename: process.platform === "win32" ? "onnxruntime_providers_tensorrt.dll" : "libonnxruntime_providers_tensorrt.so" },
  ];

  for (const provider of providerFiles) {
    if (existsSync(join(binDir, provider.filename))) {
      providers.push(provider.name);
    }
  }

  return providers;
}

function nodeSelectableDevices(): ModelDevice[] {
  const devices: ModelDevice[] = [];

  switch (process.platform) {
    case "win32":
      devices.push("dml");
      break;
    case "linux":
      if (process.arch === "x64") {
        devices.push("cuda");
      }
      break;
    default:
      break;
  }

  devices.push("cpu");
  return devices;
}

function gpuAliasTargets(selectableDevices: ModelDevice[]): ModelDevice[] {
  return selectableDevices.filter((device) => ["cuda", "dml", "webgpu", "webnn-gpu"].includes(device));
}

export async function getDeviceReport(configuredDevice: ModelDevice): Promise<DeviceReport> {
  const selectableDevices = nodeSelectableDevices();
  const backends = await Promise.resolve(onnxRuntime.listSupportedBackends?.() ?? []);
  const availableGpuTargets = gpuAliasTargets(selectableDevices);
  const localProviders = installedProviders();
  const recommendations: string[] = [];
  const notes: string[] = [];

  if (availableGpuTargets.length > 0) {
    recommendations.push(`Use --device gpu to prefer GPU execution providers (${availableGpuTargets.join(", ")}).`);
  } else {
    recommendations.push("Use --device cpu for the most predictable Node.js setup on this machine.");
  }

  const cudaBackend = backends.find((backend) => backend.name === "cuda");
  if (localProviders.includes("cuda")) {
    notes.push("CUDA provider libraries are installed locally for onnxruntime-node.");
    notes.push("If `setup --device cuda` still fails, the remaining problem is system library loading or model download access, not missing ONNX CUDA binaries.");
  } else if (cudaBackend && !cudaBackend.bundled) {
    notes.push("CUDA is a selectable device on this platform, but the current onnxruntime-node install does not have CUDA provider libraries on disk.");
    notes.push("Run `ONNXRUNTIME_NODE_INSTALL_CUDA=v12 npm rebuild onnxruntime-node` to install the CUDA 12 provider bundle.");
  }

  if (process.platform !== "linux" || process.arch !== "x64") {
    notes.push("CUDA is only considered selectable here on Linux x64, matching the current Transformers.js Node backend logic.");
  }

  notes.push("`setup` validates the selected device during model warmup, so unsupported choices fail early.");

  return {
    configuredDevice,
    selectableDevices,
    gpuAliasTargets: availableGpuTargets,
    defaultDevice: "cpu",
    onnxRuntimeBackends: backends,
    installedProviders: localProviders,
    recommendations,
    notes,
  };
}
