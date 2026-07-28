import { RunOptions } from "../types";
import {
  getLogger,
  LoggerWithMethods,
  RetryOptions,
  withRetry,
} from "../utils";
import { DBService, ApiService, ChainContext } from "../services";

// How often to log the process memory usage. This leaves a memory trail in the
// logs so a restart can be correlated with memory pressure (e.g. OOM) even when
// only the application logs are available.
const MEMORY_LOG_INTERVAL_MS = 60_000;

type WarmUpBackoff = Required<
  Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs">
>;

/**
 * How hard to try warming a chain up before abandoning it.
 *
 * `ChainContext.warmUp` already retries each individual RPC call, so reaching
 * here means that chain's endpoint has been unusable for a while. Retry the
 * whole warm-up on top of that, bounded, so an RPC outage lasting a couple of
 * minutes resolves itself without a restart: 5s, 10s, 20s, 40s.
 */
const WARM_UP_BACKOFF: WarmUpBackoff = {
  attempts: 5,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
};

/** The slice of `ChainContext` that warm-up supervision depends on */
export interface WarmUpChain {
  chainId: number;
  warmUp(oneShot?: boolean): Promise<unknown>;
  /** Flag the chain as out of sync so `/health` stops reporting it healthy */
  markUnhealthy(): void;
}

export interface WarmUpOptions {
  oneShot?: boolean;
  /** Overridable so tests don't have to wait out the production backoff */
  backoff?: WarmUpBackoff;
}

/**
 * Warm every chain up concurrently, containing failures to the chain that
 * caused them.
 *
 * `warmUp` throws once a chain has exhausted the retries on one of its RPC
 * calls. That rejection used to travel through `Promise.all` into `run()`'s
 * catch block, which exited the process - so a single unreachable endpoint took
 * down every healthy chain with it, over and over. Each chain is now retried on
 * its own with bounded backoff, and one that never comes up is marked unhealthy
 * and left behind rather than aborting its siblings.
 *
 * @returns the exit code for the run: non-zero if any chain was abandoned.
 */
export async function warmUpChains(
  chains: WarmUpChain[],
  options: WarmUpOptions = {}
): Promise<number> {
  const log = getLogger({ name: "commands:warmUpChains" });
  const { oneShot, backoff = WARM_UP_BACKOFF } = options;

  // `allSettled` rather than `all`: `warmUpChain` is written not to throw, but
  // the whole point of this function is that no single chain can abort the
  // others, so don't rely on that holding.
  const results = await Promise.allSettled(
    chains.map((chain) => warmUpChain(chain, oneShot, backoff, log))
  );

  const failed = results.filter((result) => {
    if (result.status === "rejected") {
      log.error(
        "Unexpected error thrown while warming up a chain",
        result.reason
      );
      return true;
    }
    return !result.value;
  });

  if (failed.length > 0) {
    // Healthy chains keep running; this only decides the code the process
    // eventually exits with, which for a long-running watcher means every
    // chain was abandoned and there is nothing left to watch.
    log.error(
      `${failed.length} of ${chains.length} chains could not be warmed up`
    );
    return 1;
  }

  return 0;
}

/**
 * Warm a single chain up, retrying with bounded backoff.
 * @returns whether the chain was warmed up successfully.
 */
async function warmUpChain(
  chain: WarmUpChain,
  oneShot: boolean | undefined,
  backoff: WarmUpBackoff,
  log: LoggerWithMethods
): Promise<boolean> {
  const { chainId } = chain;

  try {
    await withRetry(() => chain.warmUp(oneShot), {
      ...backoff,
      onRetry: (attempt, error, delayMs) =>
        log.warn(
          `Chain ${chainId} failed to warm up (attempt ${attempt}/${backoff.attempts}), retrying in ${delayMs}ms`,
          error
        ),
    });
    return true;
  } catch (error) {
    log.error(
      `Chain ${chainId} gave up warming up after ${backoff.attempts} attempts. Check the RPC.`,
      error
    );

    // Flag the chain so `/health` fails and the pod is restarted by its
    // liveness probe, instead of exiting the process from under the chains
    // that are working. Guarded so a broken chain cannot take out the rest
    // through the very code that is supposed to isolate it.
    try {
      chain.markUnhealthy();
    } catch (markError) {
      log.error(`Could not mark chain ${chainId} as unhealthy`, markError);
    }

    return false;
  }
}

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
  }, MEMORY_LOG_INTERVAL_MS);
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

    // Warm up each chain and then run its block watcher. Failures are
    // contained per chain, so a bad RPC endpoint cannot stop the others.
    exitCode = await warmUpChains(chainContexts, { oneShot });
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

function formatMemoryUsage(usage: NodeJS.MemoryUsage): string {
  const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return `rss=${toMB(usage.rss)}MB heapUsed=${toMB(
    usage.heapUsed
  )}MB heapTotal=${toMB(usage.heapTotal)}MB external=${toMB(usage.external)}MB`;
}
