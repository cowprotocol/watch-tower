import { RunOptions } from "../types";
import { logger, DBService } from "../utils";
import { ChainContext } from "../domain";

/**
 * Run the watch-tower 👀🐮
 * @param options Specified by the CLI / environment for running the watch-tower
 */
export async function run(options: RunOptions) {
  const log = logger.getLogger("commands:run");
  const { rpc, deploymentBlock, oneShot } = options;

  process.on("unhandledRejection", async (error) => {
    log.error("Unhandled promise rejection", error);
    await DBService.getInstance().close();
    process.exit(1);
  });

  process.on("SIGINT", async function () {
    log.info("Caught interrupt signal. Closing DB connection.");
    await DBService.getInstance().close();
    process.exit(0);
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

    // Run the block watcher for each chain
    const runPromises = chainContexts.map(async (context) => {
      return context.warmUp(oneShot);
    });

    // Run all the chain contexts
    await Promise.all(runPromises);
  } catch (error) {
    log.error("Unexpected error thrown when running watchtower", error);
    exitCode = 1;
  } finally {
    await DBService.getInstance().close();
    process.exit(exitCode);
  }
}
