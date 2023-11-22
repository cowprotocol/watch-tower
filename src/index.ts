import "dotenv/config";

import {
  program,
  Option,
  InvalidArgumentError,
} from "@commander-js/extra-typings";
import { MultiChainConfigOptions, ChainConfigOptions } from "./types";
import { getAddress, isHexString } from "ethers/lib/utils";
import { dumpDb, replayBlock, replayTx, run, runMulti } from "./commands";
import { initLogging } from "./utils";
import { version, description } from "../package.json";

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

const databasePathOption = new Option(
  "--database-path <databasePath>",
  "Path to the database"
)
  .default(DEFAULT_DATABASE_PATH)
  .env("DATABASE_PATH");

const chainConfigHelp = `Chain configuration in the format of <rpc>,<deploymentBlock>[,<watchdogTimeout>,<orderBookApi>,<filterPolicyConfig>], e.g. http://erigon.dappnode:8545,12345678,30,https://api.cow.fi/mainnet,https://raw.githubusercontent.com/cowprotocol/watch-tower/config/filter-policy-1.json`;
const multiChainConfigOption = new Option(
  "--chain-config <chainConfig...>",
  chainConfigHelp
)
  .makeOptionMandatory(true)
  .argParser(parseChainConfigOptions);

const chainConfigOption = new Option(
  "--chain-config <chainConfig>",
  chainConfigHelp
)
  .makeOptionMandatory(true)
  .env("CHAIN_CONFIG")
  .argParser(parseChainConfigOption);

const onlyOwnerOption = new Option(
  "--only-owner <onlyOwner...>",
  "Addresses of contracts / safes to monitor conditional orders for"
).argParser(parseAddressOption);

async function main() {
  program.name("watch-tower").description(description).version(version);

  program
    .command("run")
    .description("Run the watch-tower, monitoring only a single chain")
    .addOption(chainConfigOption)
    .addOption(onlyOwnerOption)
    .addOption(databasePathOption)
    .addOption(logLevelOption)
    .addOption(pageSizeOption)
    .addOption(dryRunOnlyOption)
    .addOption(oneShotOption)
    .addOption(disableApiOption)
    .addOption(apiPortOption)
    .addOption(disableNotificationsOption)
    .addOption(slackWebhookOption)
    .action((options) => {
      const { logLevel, chainConfig, onlyOwner: owners } = options;
      const [pageSize, apiPort] = [options.pageSize, options.apiPort].map(
        (value) => Number(value)
      );

      initLogging({ logLevel });

      // Run the watch-tower
      run({ ...options, ...chainConfig, owners, pageSize, apiPort });
    });

  program
    .command("run-multi")
    .description("Run the watch-tower monitoring multiple blockchains")
    .addOption(multiChainConfigOption)
    .addOption(onlyOwnerOption)
    .addOption(databasePathOption)
    .addOption(logLevelOption)
    .addOption(pageSizeOption)
    .addOption(dryRunOnlyOption)
    .addOption(oneShotOption)
    .addOption(disableApiOption)
    .addOption(apiPortOption)
    .addOption(disableNotificationsOption)
    .addOption(slackWebhookOption)
    .action((options) => {
      const {
        logLevel,
        chainConfig: chainConfigs,
        onlyOwner: owners,
      } = options;
      const [pageSize, apiPort] = [options.pageSize, options.apiPort].map(
        (value) => Number(value)
      );

      initLogging({ logLevel });

      // Run the watch-tower
      runMulti({
        ...options,
        ...chainConfigs,
        owners,
        pageSize,
        apiPort,
      });
    });

  program
    .command("dump-db")
    .description("Dump database as JSON to STDOUT")
    .requiredOption("--chain-id <chainId>", "Chain ID to dump")
    .addOption(logLevelOption)
    .addOption(databasePathOption)
    .action((options) => {
      const { logLevel } = options;
      initLogging({ logLevel });

      // Ensure that the chain ID is a number
      const chainId = Number(options.chainId);
      if (isNaN(chainId)) {
        throw new Error("Chain ID must be a number");
      }

      // Dump the database
      dumpDb({ ...options, chainId });
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
      const { logLevel } = options;
      initLogging({ logLevel });

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
    .addOption(chainConfigOption)
    .addOption(dryRunOnlyOption)
    .addOption(logLevelOption)
    .addOption(databasePathOption)
    .requiredOption("--tx <tx>", "Transaction hash to replay")
    .action((options) => {
      const { logLevel, chainConfig } = options;
      initLogging({ logLevel });

      replayTx({ ...options, ...chainConfig });
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

function parseChainConfigOption(option: string): ChainConfigOptions {
  // Split the option using ',' as the delimiter
  const parts = option.split(",");

  // Ensure there are at least two parts (rpc and deploymentBlock)
  if (parts.length < 2) {
    throw new InvalidArgumentError(
      `Chain configuration must be in the format of <rpc>,<deploymentBlock>[,<watchdogTimeout>,<orderBookApi>,<filterPolicyConfig>], e.g. http://erigon.dappnode:8545,12345678,30,https://api.cow.fi/mainnet,https://raw.githubusercontent.com/cowprotocol/watch-tower/config/filter-policy-1.json`
    );
  }

  // Extract rpc and deploymentBlock from the parts
  const rpc = parts[0];
  // Ensure that the RPC is a valid URL
  if (!isValidUrl(rpc)) {
    throw new InvalidArgumentError(
      `${rpc} must be a valid URL (RPC) (chainConfig)`
    );
  }

  const rawDeploymentBlock = parts[1];
  // Ensure that the deployment block is a positive number
  const deploymentBlock = Number(rawDeploymentBlock);
  if (isNaN(deploymentBlock) || deploymentBlock < 0) {
    throw new InvalidArgumentError(
      `${rawDeploymentBlock} must be a positive number (deployment block)`
    );
  }

  const rawWatchdogTimeout = parts[2];
  // If there is a third part, it is the watchdogTimeout
  const watchdogTimeout =
    parts.length > 2 && rawWatchdogTimeout ? Number(rawWatchdogTimeout) : 30;
  // Ensure that the watchdogTimeout is a positive number
  if (isNaN(watchdogTimeout) || watchdogTimeout < 0) {
    throw new InvalidArgumentError(
      `${rawWatchdogTimeout} must be a positive number (watchdogTimeout)`
    );
  }

  // If there is a fourth part, it is the orderBookApi
  const orderBookApi = parts.length > 3 && parts[3] ? parts[3] : undefined;
  // Ensure that the orderBookApi is a valid URL
  if (orderBookApi && !isValidUrl(orderBookApi)) {
    throw new InvalidArgumentError(
      `${orderBookApi} must be a valid URL (orderBookApi)`
    );
  }

  // If there is a fifth part, it is the filterPolicyConfig
  const filterPolicyConfig =
    parts.length > 4 && parts[4] ? parts[4] : undefined;
  // Ensure that the orderBookApi is a valid URL
  if (filterPolicyConfig && !isValidUrl(filterPolicyConfig)) {
    throw new InvalidArgumentError(
      `${filterPolicyConfig} must be a valid URL (orderBookApi)`
    );
  }

  return {
    rpc,
    deploymentBlock,
    watchdogTimeout,
    orderBookApi,
    filterPolicyConfig,
  };
}

function parseChainConfigOptions(
  option: string,
  previous: MultiChainConfigOptions = {
    rpcs: [],
    deploymentBlocks: [],
    watchdogTimeouts: [],
    orderBookApis: [],
    filterPolicyConfigFiles: [],
  }
): MultiChainConfigOptions {
  const parsedOption = parseChainConfigOption(option);
  const {
    rpc,
    deploymentBlock,
    watchdogTimeout,
    orderBookApi,
    filterPolicyConfig,
  } = parsedOption;

  previous.rpcs.push(rpc);
  previous.deploymentBlocks.push(deploymentBlock);
  previous.watchdogTimeouts.push(watchdogTimeout);
  previous.orderBookApis.push(orderBookApi);
  previous.filterPolicyConfigFiles.push(filterPolicyConfig);
  return previous;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

function parseAddressOption(option: string, previous: string[] = []): string[] {
  // Use ethers to validate the address
  try {
    if (!isHexString(option)) {
      throw new Error();
    }
    getAddress(option);
  } catch (error) {
    throw new InvalidArgumentError(
      `${option} must be a valid '0x' prefixed address`
    );
  }
  return [...previous, option];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
