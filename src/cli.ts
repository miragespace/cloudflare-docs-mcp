import { Command } from "commander";
import { loadConfig, formatSetupHint } from "./config.js";
import { DatabaseStore } from "./db.js";
import { getDeviceReport } from "./devices.js";
import { startHttpServer } from "./http-server.js";
import { TransformersWorkerModelClient } from "./model-client.js";
import { SearchEngine } from "./search.js";
import { runSetup, runSync } from "./sync.js";
import { APP_NAME, APP_VERSION, MODEL_DEVICE_VALUES } from "./constants.js";
import type { ModelDevice } from "./types.js";
import { fileExists } from "./utils.js";

function validateModelDevice(value: string): ModelDevice {
  if ((MODEL_DEVICE_VALUES as readonly string[]).includes(value)) {
    return value as ModelDevice;
  }
  throw new Error(`Invalid device "${value}". Expected one of: ${MODEL_DEVICE_VALUES.join(", ")}`);
}

async function loadCommandConfig(modelDevice?: ModelDevice) {
  return loadConfig(process.cwd(), {
    modelDevice,
  });
}

function createModelClient(
  config: Awaited<ReturnType<typeof loadCommandConfig>>,
  allowRemoteModels: boolean,
): TransformersWorkerModelClient {
  return new TransformersWorkerModelClient({
    cacheDir: config.storage.modelCacheDir,
    allowRemoteModels,
    embeddingModelId: config.models.embeddingModelId,
    rerankerModelId: config.models.rerankerModelId,
    device: config.models.device,
  });
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  let current: unknown = error.cause;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join("\nCaused by: ");
}

function createReporter(): (message: string) => void {
  return (message: string) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };
}

async function withSearchEngine<T>(
  allowRemoteModels: boolean,
  modelDevice: ModelDevice | undefined,
  handler: (searchEngine: SearchEngine, config: Awaited<ReturnType<typeof loadCommandConfig>>) => Promise<T>,
): Promise<T> {
  const config = await loadCommandConfig(modelDevice);
  if (!(await fileExists(config.storage.dbPath))) {
    throw new Error("Local index is missing. Run `npm run setup` first.");
  }
  const store = new DatabaseStore(config.storage.dbPath, { readonly: true });
  const modelClient = createModelClient(config, allowRemoteModels);
  const searchEngine = new SearchEngine(config, store, modelClient);

  try {
    return await handler(searchEngine, config);
  } finally {
    await searchEngine.close();
    store.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program.name(APP_NAME).version(APP_VERSION);

  program
    .command("setup")
    .description("Download the latest Cloudflare llms-full.txt corpus, build the local index, and warm local model assets.")
    .option("--device <device>", "Model device to use during setup", validateModelDevice)
    .action(async (options: { device?: ModelDevice }) => {
      const config = await loadCommandConfig(options.device);
      const report = createReporter();
      report(`Starting setup with device=${config.models.device}`);
      report(`Corpus source: ${config.corpus.sourceUrl}`);
      const modelClient = createModelClient(config, true);

      try {
        const summary = await runSetup(config, modelClient, report);
        console.log(JSON.stringify(summary, null, 2));
        console.log("");
        console.log(formatSetupHint(config));
      } finally {
        await modelClient.close();
      }
    });

  program
    .command("sync")
    .description("Refresh the local Cloudflare docs index from the latest remote llms-full.txt corpus.")
    .option("--device <device>", "Model device to use during sync", validateModelDevice)
    .action(async (options: { device?: ModelDevice }) => {
      const config = await loadCommandConfig(options.device);
      const report = createReporter();
      report(`Starting sync with device=${config.models.device}`);
      report(`Corpus source: ${config.corpus.sourceUrl}`);
      const modelClient = createModelClient(config, true);

      try {
        const summary = await runSync(config, modelClient, report);
        console.log(JSON.stringify(summary, null, 2));
      } finally {
        await modelClient.close();
      }
    });

  program
    .command("status")
    .description("Print local index status and last sync metadata.")
    .action(async () => {
      const config = await loadCommandConfig();
      if (!(await fileExists(config.storage.dbPath))) {
        console.log(JSON.stringify({
          databaseReady: false,
          dbPath: config.storage.dbPath,
          corpusPath: config.storage.corpusPath,
          documentCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
        }, null, 2));
        return;
      }
      const store = new DatabaseStore(config.storage.dbPath, { readonly: true });
      try {
        console.log(JSON.stringify(store.getStatus(config.storage.dbPath, config.storage.corpusPath), null, 2));
      } finally {
        store.close();
      }
    });

  program
    .command("devices")
    .description("Show model devices that this local runtime can target.")
    .action(async () => {
      const config = await loadCommandConfig();
      console.log(JSON.stringify(await getDeviceReport(config.models.device), null, 2));
    });

  program
    .command("serve")
    .description("Serve the local Cloudflare docs MCP endpoint over Streamable HTTP.")
    .option("--device <device>", "Model device to use while serving", validateModelDevice)
    .action(async (options: { device?: ModelDevice }) => {
      await withSearchEngine(false, options.device, async (searchEngine, config) => {
        await searchEngine.warmup();
        const server = await startHttpServer(config, searchEngine);
        console.log(`Listening on http://${config.server.host}:${config.server.port}${config.server.mcpPath}`);

        const stop = async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        };

        process.on("SIGINT", () => {
          stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        });
        process.on("SIGTERM", () => {
          stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        });

        await new Promise<void>(() => undefined);
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
