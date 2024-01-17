import "dotenv/config";
import Ajv, { JSONSchemaType } from "ajv";
import addFormats from "ajv-formats";
import fs from "fs";
import path from "path";

import {
  program,
  Option,
  InvalidArgumentError,
} from "@commander-js/extra-typings";
import { Config } from "./types";
import { getAddress, isHexString } from "ethers/lib/utils";
import { dumpDb, run } from "./commands";
import { initLogging } from "./utils";
import { version, description } from "../package.json";

const CONFIG_SCHEMA_PATH = path.join(__dirname, "types", "config.schema.json");
const DEFAULT_DATABASE_PATH = "./database";
const DEFAULT_CONFIG_PATH = "./config.json";

const logLevelOption = new Option("--log-level <logLevel>", "Log level")
  .default("INFO")
  .env("LOG_LEVEL");

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

const configPathOption = new Option(
  "--config-path <configPath>",
  "Path to chain configuration file"
)
  .default(DEFAULT_CONFIG_PATH)
  .env("CONFIG_PATH");

const onlyOwnerOption = new Option(
  "--only-owner <onlyOwner...>",
  "Addresses of contracts / safes to monitor conditional orders for"
).argParser(parseAddressOption);

async function main() {
  program.name("watch-tower").description(description).version(version);

  program
    .command("run")
    .description("Run the watch-tower")
    .addOption(configPathOption)
    .addOption(onlyOwnerOption)
    .addOption(databasePathOption)
    .addOption(logLevelOption)
    .addOption(dryRunOnlyOption)
    .addOption(oneShotOption)
    .addOption(disableApiOption)
    .addOption(apiPortOption)
    .addOption(disableNotificationsOption)
    .addOption(slackWebhookOption)
    .action((options) => {
      const { logLevel, configPath, onlyOwner: owners } = options;

      // Load the config file
      const config = validateJSON(configPath);

      const apiPort = Number(options.apiPort);

      initLogging({ logLevel });

      // Run the watch-tower
      run({
        ...options,
        ...config,
        owners,
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

  await program.parseAsync();
}

function parseIntOption(option: string) {
  const parsed = Number(option);
  if (isNaN(parsed)) {
    throw new InvalidArgumentError(`${option} must be a number`);
  }
  return parsed.toString();
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

function validateJSON(filePath: string): Config {
  const ajv = new Ajv();
  addFormats(ajv);
  const schema: JSONSchemaType<Config> = JSON.parse(
    fs.readFileSync(CONFIG_SCHEMA_PATH, "utf8")
  );
  const validate = ajv.compile(schema);
  try {
    // Read and prase the JSON file
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Validate the data against the schema
    if (!validate(data)) {
      console.error("Configuration file validation failed:", validate.errors);
      process.exit(1);
    }

    return data;
  } catch (error) {
    console.error("Error parsing configuration file:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
