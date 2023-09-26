import { program } from "@commander-js/extra-typings";
import { ReplayBlockOptions, ReplayTxOptions, RunOptions } from "./types";
import { replayBlock, replayTx, run } from "./modes";

async function main() {
  program
    .name("watchtower")
    .description("Monitoring Composable CoW smart orders on the blockchain 🐮")
    .version("0.2.0");

  program
    .command("run")
    .description("Run the watchtower")
    .requiredOption("--rpc <rpc...>", "Chain RPC endpoints to monitor")
    .requiredOption(
      "--contract <contractAddress>",
      "ComposableCoW contract address"
    )
    .requiredOption(
      "--deployment-block <deploymentBlock...>",
      "Block number at which the contracts were deployed"
    )
    .option(
      "--page-size <pageSize>",
      "Number of blocks to fetch per page",
      "5000"
    )
    .option("--publish", "Publish orders to the OrderBook API", true)
    .addHelpText(
      "before",
      "RPC and deployment blocks must be the same length, and in the same order"
    )
    .action((options: RunOptions) => {
      // Need to assert that the RPCs and deployment blocks are the same length
      const { rpc, deploymentBlock } = options;

      if (rpc.length !== deploymentBlock.length) {
        throw new Error("RPC and deployment blocks must be the same length");
      }

      // Run the watchtower
      run(options);
    });

  program
    .command("replay-block")
    .description("Replay a block")
    .requiredOption("--rpc <rpc>", "Chain RPC endpoint to execute on")
    .requiredOption(
      "--contract <contractAddress>",
      "ComposableCoW contract address"
    )
    .requiredOption("--block <block>", "Block number to replay")
    .option(
      "--publish",
      "Publish any new discrete orders to the OrderBook API",
      true
    )
    .action((options: ReplayBlockOptions) => replayBlock(options));

  program
    .command("replay-tx")
    .description("Reply a transaction")
    .requiredOption("--rpc <rpc>", "Chain RPC endpoint to execute on")
    .requiredOption("--contract <contract>", "ComposableCoW contract address")
    .requiredOption("--tx <tx>", "Transaction hash to replay")
    .option(
      "--publish",
      "Publish any new discrete orders to the OrderBook API",
      true
    )
    .action((options: ReplayTxOptions) => replayTx(options));

  await program.parseAsync();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
