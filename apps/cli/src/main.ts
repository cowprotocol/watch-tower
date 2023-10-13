import "dotenv/config";

import {
  program,
  Option,
  InvalidArgumentError,
} from "@commander-js/extra-typings";
import { ReplayTxOptions } from "./types";
import { dumpDb, replayBlock, replayTx, run, runMulti } from "./commands";
import { initLogging } from "./utils";
import { version, description } from "../../../package.json";

const DEFAULT_DATABASE_PATH = "./database";

const logLevelOption = new Option("--log-level <logLevel>", "Log level")
  .default("INFO")
  .env("LOG_LEVEL");

const pageSizeOption = new Option(
  "--page-size <pageSize>",
  "Number of historical blocks to fetch per page from eth_getLogs"
)
  .default("5000")
  .env("PAGE_SIZE")
  .argParser(parseIntOption);

const disableNotificationsOption = new Option(
  "--silent",
  "Disable notifications (local logging only)"
)
  .conflicts(["slackWebhook"])
  .default(false)
  .env("DISABLE_NOTIFICATIONS");

const dryRunOnlyOption = new Option(
  "--dry-run",
  "Do not publish orders to the OrderBook API"
)
  .default(false)
  .env("DRY_RUN");

const disableApiOption = new Option("--disable-api", "Disable the REST API")
  .default(false)
  .env("DISABLE_API");

const apiPortOption = new Option(
  "--api-port <apiPort>",
  "Port for the REST API"
)
  .default("8080")
  .env("API_PORT")
  .argParser(parseIntOption);

const oneShotOption = new Option(
  "--one-shot",
  "Run the watch-tower once and exit"
)
  .default(false)
  .env("ONE_SHOT");

const slackWebhookOption = new Option(
  "--slack-webhook <slackWebhook>",
  "Slack webhook URL"
).env("SLACK_WEBHOOK");

const watchdogTimeoutOption = new Option(
  "--watchdog-timeout <watchdogTimeout>",
  "Watchdog timeout (in seconds)"
)
  .default("30")
  .env("WATCHDOG_TIMEOUT")
  .argParser(parseIntOption);

const databasePathOption = new Option(
  "--database-path <databasePath>",
  "Path to the database"
)
  .default(DEFAULT_DATABASE_PATH)
  .env("DATABASE_PATH");

const multiRpcOption = new Option(
  "--rpc <rpc...>",
  "Chain RPC endpoints to monitor"
).makeOptionMandatory(true);

const rpcOption = new Option("--rpc <rpc>", "Chain RPC endpoint to monitor")
  .makeOptionMandatory(true)
  .env("RPC");

const multiDeploymentBlockOption = new Option(
  "--deployment-block <deploymentBlocks...>",
  "Block number at which the ComposableCoW contract was deployed on the respective chains"
).makeOptionMandatory(true);

const deploymentBlockOption = new Option(
  "--deployment-block <deploymentBlock>",
  "Block number at which the ComposableCoW was deployed"
)
  .makeOptionMandatory(true)
  .env("DEPLOYMENT_BLOCK")
  .argParser(parseIntOption);

async function main() {
  program.name("watch-tower").description(description).version(version);

  program
    .command("run")
    .description("Run the watch-tower, monitoring only a single chain")
    .addOption(rpcOption)
    .addOption(deploymentBlockOption)
    .addOption(databasePathOption)
    .addOption(logLevelOption)
    .addOption(watchdogTimeoutOption)
    .addOption(pageSizeOption)
    .addOption(dryRunOnlyOption)
    .addOption(oneShotOption)
    .addOption(disableApiOption)
    .addOption(apiPortOption)
    .addOption(disableNotificationsOption)
    .addOption(slackWebhookOption)
    .action((options) => {
      const { rpc, databasePath, logLevel, silent, disableApi, dryRun } =
        options;
      const [pageSize, apiPort, watchdogTimeout, deploymentBlock] = [
        options.pageSize,
        options.apiPort,
        options.watchdogTimeout,
        options.deploymentBlock,
      ].map((value) => Number(value));

      initLogging({ logLevel });

      // Run the watch-tower
      run({
        rpc,
        databasePath,
        deploymentBlock,
        pageSize,
        apiPort,
        watchdogTimeout,
        silent,
        disableApi,
        dryRun,
        logLevel,
      });
    });

  program
    .command("run-multi")
    .description("Run the watch-tower monitoring multiple blockchains")
    .addHelpText(
      "before",
      "RPC and deployment blocks must be the same length, and in the same order"
    )
    .addOption(multiRpcOption)
    .addOption(multiDeploymentBlockOption)
    .addOption(databasePathOption)
    .addOption(logLevelOption)
    .addOption(watchdogTimeoutOption)
    .addOption(pageSizeOption)
    .addOption(dryRunOnlyOption)
    .addOption(oneShotOption)
    .addOption(disableApiOption)
    .addOption(apiPortOption)
    .addOption(disableNotificationsOption)
    .addOption(slackWebhookOption)
    .action((options) => {
      const { logLevel } = options;
      const [pageSize, apiPort, watchdogTimeout] = [
        options.pageSize,
        options.apiPort,
        options.watchdogTimeout,
      ].map((value) => Number(value));

      initLogging({ logLevel });
      const {
        rpc: rpcs,
        deploymentBlock: deploymentBlocksEnv,
        disableApi,
        dryRun,
        databasePath,
      } = options;

      // Ensure that the deployment blocks are all numbers
      const deploymentBlocks = deploymentBlocksEnv.map((block) =>
        Number(block)
      );
      if (deploymentBlocks.some((block) => isNaN(block))) {
        throw new Error("Deployment blocks must be numbers");
      }

      // Ensure that the RPCs and deployment blocks are the same length
      if (rpcs.length !== deploymentBlocks.length) {
        throw new Error("RPC and deployment blocks must be the same length");
      }

      // Run the watch-tower
      runMulti({
        rpcs,
        deploymentBlocks,
        pageSize,
        apiPort,
        watchdogTimeout,
        disableApi,
        dryRun,
        logLevel,
        databasePath,
      });
    });

  program
    .command("dump-db")
    .description("Dump database as JSON to STDOUT")
    .requiredOption("--chain-id <chainId>", "Chain ID to dump")
    .addOption(logLevelOption)
    .addOption(databasePathOption)
    .action((options) => {
      const { logLevel, databasePath } = options;
      initLogging({ logLevel });

      // Ensure that the chain ID is a number
      const chainId = Number(options.chainId);
      if (isNaN(chainId)) {
        throw new Error("Chain ID must be a number");
      }

      // Dump the database
      dumpDb({ chainId, logLevel, databasePath });
    });

  program
    .command("replay-block")
    .description("Replay a block")
    .requiredOption("--rpc <rpc>", "Chain RPC endpoint to execute on")
    .requiredOption("--block <block>", "Block number to replay")
    .addOption(dryRunOnlyOption)
    .addOption(logLevelOption)
    .addOption(databasePathOption)
    .action((options) => {
      const { logLevel, rpc, dryRun, databasePath } = options;
      initLogging({ logLevel });

      // Ensure that the block is a number
      const block = Number(options.block);
      if (isNaN(block)) {
        throw new Error("Block must be a number");
      }

      replayBlock({ block, rpc, dryRun, logLevel, databasePath });
    });

  program
    .command("replay-tx")
    .description("Reply a transaction")
    .addOption(rpcOption)
    .addOption(dryRunOnlyOption)
    .addOption(logLevelOption)
    .addOption(databasePathOption)
    .requiredOption("--tx <tx>", "Transaction hash to replay")
    .action((options) => {
      const { tx, rpc, dryRun, logLevel, databasePath } = options;
      initLogging({ logLevel });

      replayTx({ tx, rpc, dryRun, logLevel, databasePath });
    });

  await program.parseAsync();
}

function parseIntOption(option: string) {
  const parsed = Number(option);
  if (isNaN(parsed)) {
    throw new InvalidArgumentError(`${option} must be a number`);
  }
  return parsed.toString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
