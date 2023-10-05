import { RunOptions } from "../types";
import { getLogger, DBService } from "../utils";
import { ChainContext } from "../domain";
import { ApiService } from "../utils/api";

/**
 * Run the watch-tower 👀🐮
 * @param options Specified by the CLI / environment for running the watch-tower
 */
export async function run(options: RunOptions) {
  const log = getLogger("commands:run");
  const { rpc, deploymentBlock, oneShot, disableApi, apiPort } = options;

  // Start the API server if it's not disabled
  if (!disableApi) {
    log.info("Starting Rest API server...");
    const api = ApiService.getInstance(apiPort);
    await api.start();
  }

  process.on("unhandledRejection", async (error) => {
    log.error("Unhandled promise rejection", error);
    stop(1);
  });

  process.on("SIGINT", async function () {
    log.info("Caught interrupt signal.");
    stop();
  });

  let exitCode = 0;
  try {
    const chainContexts = await Promise.all(
      rpc.map((rpc, index) => {
        return ChainContext.init(
          {
            ...options,
            rpc,
            deploymentBlock: deploymentBlock[index],
          },
          DBService.getInstance()
        );
      })
    );

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
    stop(exitCode);
  }
}

/**
 * Run actions required when stopping the watch-tower from run mode
 * @param exitCode Exit code to return to the shell
 */
function stop(exitCode?: number) {
  const log = getLogger("commands:stop");
  log.info("Stopping Rest API server...");
  ApiService.getInstance().stop();
  log.info("Closing database...");
  DBService.getInstance().close();
  log.info("Exiting watchtower...");
  process.exit(exitCode || 0);
}
