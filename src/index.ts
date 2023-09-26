import { program, Option } from "@commander-js/extra-typings";
import { ReplayTxOptions } from "./types";
import { replayBlock, replayTx, run } from "./commands";

async function main() {
  program
    .name("watchtower")
    .description("Monitoring Composable CoW smart orders on the blockchain 🐮")
    .version("0.2.0");

  program
    .command("run")
    .description("Run the watchtower")
    .addHelpText(
      "before",
      "RPC and deployment blocks must be the same length, and in the same order"
    )
    .requiredOption("--rpc <rpc...>", "Chain RPC endpoints to monitor")
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
    .addOption(
      new Option("--silent", "Disable notifications (local logging only)")
        .conflicts(["slackWebhook", "sentryDsn", "logglyToken"])
        .default(false)
    )
    .option("--slack-webhook <slackWebhook>", "Slack webhook URL")
    .option("--sentry-dsn <sentryDsn>", "Sentry DSN")
    .option("--loggly-token <logglyToken>", "Loggly token")
    .option("--one-shot", "Run the watchtower once and exit", false)
    .action((options) => {
      const {
        rpc,
        deploymentBlock: deploymentBlockEnv,
        pageSize: pageSizeEnv,
      } = options;

      // Ensure that the deployment blocks are all numbers
      const deploymentBlock = deploymentBlockEnv.map((block) => Number(block));
      if (deploymentBlock.some((block) => isNaN(block))) {
        throw new Error("Deployment blocks must be numbers");
      }

      // Ensure that pageSize is a number
      const pageSize = Number(pageSizeEnv);
      if (isNaN(pageSize)) {
        throw new Error("Page size must be a number");
      }

      // Ensure that the RPCs and deployment blocks are the same length
      if (rpc.length !== deploymentBlock.length) {
        throw new Error("RPC and deployment blocks must be the same length");
      }

      // Run the watchtower
      run({ ...options, deploymentBlock, pageSize });
    });

  program
    .command("replay-block")
    .description("Replay a block")
    .requiredOption("--rpc <rpc>", "Chain RPC endpoint to execute on")
    .requiredOption("--block <block>", "Block number to replay")
    .option(
      "--publish",
      "Publish any new discrete orders to the OrderBook API",
      true
    )
    .action((options) => {
      // Ensure that the block is a number
      const block = Number(options.block);
      if (isNaN(block)) {
        throw new Error("Block must be a number");
      }

      replayBlock({ ...options, block });
    });

  program
    .command("replay-tx")
    .description("Reply a transaction")
    .requiredOption("--rpc <rpc>", "Chain RPC endpoint to execute on")
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
