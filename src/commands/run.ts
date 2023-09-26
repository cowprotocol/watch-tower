import { RunOptions } from "../types";
import { DBService } from "../utils";
import { ChainContext } from "../domain";

/**
 * Run the watch-tower 👀🐮
 * @param options Specified by the CLI / environment for running the watch-tower
 */
export async function run(options: RunOptions) {
  const { rpc, deploymentBlock, oneShot } = options;

  process.on("unhandledRejection", async (error) => {
    console.log(error);
    await DBService.getInstance().close();
    process.exit(1);
  });

  process.on("SIGINT", async function () {
    console.log("️⚠️ Caught interrupt signal. Closing DB connection.");
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
    console.error(error);
    exitCode = 1;
  } finally {
    await DBService.getInstance().close();
    process.exit(exitCode);
  }
}
