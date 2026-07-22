import { RunOptions } from "../types";
import { formatMemoryUsage, getLogger } from "../utils";
import { DBService, ApiService, ChainContext } from "../services";

// How often to log the process memory usage. This leaves a memory trail in the
// logs so a restart can be correlated with memory pressure (e.g. OOM) even when
// only the application logs are available.
const MEMORY_LOG_FREQUENCY_SECS = 60;

/**
 * Run the watch-tower 👀🐮
 * @param options Specified by the CLI / environment for running the watch-tower
 */
export async function run(options: RunOptions) {
  const log = getLogger({ name: "commands:run" });
  const { oneShot, disableApi, apiPort, databasePath, networks } = options;

  // Open the database
  const storage = DBService.getInstance(databasePath);

  // Start the API server if it's not disabled
  let api: ApiService | undefined;
  if (!disableApi) {
    log.info("Starting Rest API server...");
    api = ApiService.getInstance(apiPort);
    await api.start();
  }

  // Periodically log memory usage. `unref()` ensures this timer never keeps the
  // process alive on its own.
  log.info(`Memory usage: ${formatMemoryUsage(process.memoryUsage())}`);
  const memoryLogInterval = setInterval(() => {
    log.info(`Memory usage: ${formatMemoryUsage(process.memoryUsage())}`);
  }, MEMORY_LOG_FREQUENCY_SECS * 1000);
  memoryLogInterval.unref();

  process.on("unhandledRejection", async (error) => {
    log.error("Unhandled promise rejection", error);
    await stop(1, memoryLogInterval);
  });

  // Handle both termination signals so that shutdowns are graceful and, more
  // importantly, leave a log trail. Kubernetes sends SIGTERM to restart a pod
  // (rollout, eviction, failing liveness probe); without a handler Node exits
  // instantly and silently, making a routine k8s restart indistinguishable in
  // the logs from an uncatchable SIGKILL / OOM kill.
  const handleSignal = (signal: NodeJS.Signals) => async () => {
    log.info(`Caught ${signal} signal. Shutting down...`);
    await stop(0, memoryLogInterval);
  };
  process.on("SIGINT", handleSignal("SIGINT"));
  process.on("SIGTERM", handleSignal("SIGTERM"));

  let exitCode = 0;
  try {
    const chainContexts = await Promise.all(
      networks.map((network) => {
        const { name } = network;
        log.info(`Starting chain ${name}...`);
        return ChainContext.init(
          {
            ...options,
            ...network,
          },
          storage
        );
      })
    );

    // Set the chain contexts on the API server
    api?.setChainContexts(chainContexts);

    // Run the block watcher after warm up for each chain
    const runPromises = chainContexts.map(async (context) => {
      return context.warmUp(oneShot);
    });

    // Run all the chain contexts
    await Promise.all(runPromises);
  } catch (error) {
    log.error("Unexpected error thrown when running watchtower", error);
    exitCode = 1;
  } finally {
    await stop(exitCode, memoryLogInterval);
  }
}

/**
 * Run actions required when stopping the watch-tower from run mode
 * @param exitCode Exit code to return to the shell
 * @param memoryLogInterval Memory logging timer to clear before exiting
 */
async function stop(exitCode?: number, memoryLogInterval?: NodeJS.Timeout) {
  const log = getLogger({ name: "commands:stop" });
  if (memoryLogInterval) {
    clearInterval(memoryLogInterval);
  }
  const stopServices = [
    ApiService.getInstance().stop(),
    DBService.getInstance().close(),
  ];
  await Promise.allSettled(stopServices).then((results) => {
    results.forEach((result) => {
      if (result.status === "rejected") {
        log.error("Error stopping service", result.reason);
      }
    });
  });
  log.info("Exiting watchtower...");
  process.exit(exitCode || 0);
}
