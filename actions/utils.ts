import assert = require("assert");
import Slack = require("node-slack");
import { Context } from "@tenderly/actions";

import { ethers } from "ethers";
import { ConnectionInfo, Logger } from "ethers/lib/utils";

import {
  init as sentryInit,
  startTransaction as sentryStartTransaction,
  Transaction as SentryTransaction,
} from "@sentry/node";
import { CaptureConsole as CaptureConsoleIntegration } from "@sentry/integrations";

import { ExecutionContext, OrderStatus, Registry } from "./model";
import { ComposableCoW__factory } from "./types";
import {
  ALL_SUPPORTED_CHAIN_IDS,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";

type LocalChainId = 31337;
const LOCAL_CHAIN_ID = 31337;
const NOTIFICATION_WAIT_PERIOD = 1000 * 60 * 60 * 2; // 2h - Don't send more than one notification every 2h

// Selectors that are required to be part of the contract's bytecode in order to be considered compatible
const REQUIRED_SELECTORS = [
  "cabinet(address,bytes32)",
  "getTradeableOrderWithSignature(address,(address,bytes32,bytes),bytes,bytes32[])",
];

// These are the `sighash` of the custom errors, with sighashes being calculated the same way for custom
// errors as they are for functions in solidity.
export const ORDER_NOT_VALID_SELECTOR = "0xc8fc2725";
export const SINGLE_ORDER_NOT_AUTHED_SELECTOR = "0x7a933234";
export const PROOF_NOT_AUTHED_SELECTOR = "0x4a821464";

let executionContext: ExecutionContext | undefined;

export async function init(
  transactionName: string,
  chainId: SupportedChainId,
  context: Context
): Promise<ExecutionContext> {
  // Init registry
  const registry = await Registry.load(context, chainId.toString());

  // Get notifications config (enabled by default)
  const notificationsEnabled = await _getNotificationsEnabled(context);

  // Init slack
  const slack = await _getSlack(notificationsEnabled, context);

  // Init Sentry
  const sentryTransaction = await _getSentry(transactionName, chainId, context);
  if (!sentryTransaction) {
    console.warn("SENTRY_DSN secret is not set. Sentry will be disabled");
  }

  executionContext = {
    registry,
    slack,
    sentryTransaction,
    notificationsEnabled,
    context,
  };

  return executionContext;
}

async function _getNotificationsEnabled(context: Context): Promise<boolean> {
  // Get notifications config (enabled by default)
  return context.secrets
    .get("NOTIFICATIONS_ENABLED")
    .then((value) => (value ? value !== "false" : true))
    .catch(() => true);
}

async function _getSlack(
  notificationsEnabled: boolean,
  context: Context
): Promise<Slack | undefined> {
  if (executionContext) {
    return executionContext?.slack;
  }

  // Init slack
  let slack;
  const webhookUrl = await context.secrets
    .get("SLACK_WEBHOOK_URL")
    .catch(() => "");
  if (!notificationsEnabled) {
    return undefined;
  }

  if (!webhookUrl) {
    throw new Error(
      "SLACK_WEBHOOK_URL secret is required when NOTIFICATIONS_ENABLED is true"
    );
  }

  return new Slack(webhookUrl);
}

async function _getSentry(
  transactionName: string,
  chainId: SupportedChainId,
  context: Context
): Promise<SentryTransaction | undefined> {
  // Init Sentry
  if (!executionContext) {
    const sentryDsn = await context.secrets.get("SENTRY_DSN").catch(() => "");
    sentryInit({
      dsn: sentryDsn,
      debug: false,
      tracesSampleRate: 1.0, // Capture 100% of the transactions. Consider reducing in production.
      integrations: [
        new CaptureConsoleIntegration({
          levels: ["error", "warn", "log", "info"],
        }),
      ],
      initialScope: {
        tags: {
          network: chainId,
        },
      },
    });
  }

  // Return transaction
  return sentryStartTransaction({
    name: transactionName,
    op: "action",
  });
}

async function getSecret(key: string, context: Context): Promise<string> {
  const value = await context.secrets.get(key);
  assert(value, `${key} secret is required`);

  return value;
}

export async function getProvider(
  context: Context,
  chainId: SupportedChainId
): Promise<ethers.providers.Provider> {
  Logger.setLogLevel(Logger.levels.DEBUG);

  const url = await getSecret(`NODE_URL_${chainId}`, context);
  const user = await getSecret(`NODE_USER_${chainId}`, context).catch(
    () => undefined
  );
  const password = await getSecret(`NODE_PASSWORD_${chainId}`, context).catch(
    () => undefined
  );
  const providerConfig: ConnectionInfo =
    user && password
      ? {
          url,
          // TODO: This is a hack to make it work for HTTP endpoints (while we don't have a HTTPS one for Gnosis Chain), however I will delete once we have it
          headers: {
            Authorization: getAuthHeader({ user, password }),
          },
          // user: await getSecret(`NODE_USER_${network}`, context),
          // password: await getSecret(`NODE_PASSWORD_${network}`, context),
        }
      : { url };

  return new ethers.providers.JsonRpcProvider(providerConfig);
}

function getAuthHeader({ user, password }: { user: string; password: string }) {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

// TODO: If we use the Ordebook  API a lot of code will be deleted. Out of the scope of this PR (a lot has to be cleaned)
export function apiUrl(chainId: SupportedChainId | LocalChainId): string {
  switch (chainId) {
    case SupportedChainId.MAINNET:
      return "https://api.cow.fi/mainnet";
    case SupportedChainId.GOERLI:
      return "https://api.cow.fi/goerli";
    case SupportedChainId.GNOSIS_CHAIN:
      return "https://api.cow.fi/xdai";
    case LOCAL_CHAIN_ID:
      return "http://localhost:3000";
    default:
      throw "Unsupported network";
  }
}

export function formatStatus(status: OrderStatus) {
  switch (status) {
    case OrderStatus.FILLED:
      return "FILLED";
    case OrderStatus.SUBMITTED:
      return "SUBMITTED";
    default:
      return `UNKNOWN (${status})`;
  }
}

export async function handleExecutionError(e: any) {
  try {
    const errorMessage = e?.message || "Unknown error";
    const notified = sendSlack(
      errorMessage +
        ". More info https://dashboard.tenderly.co/devcow/project/actions"
    );

    if (notified && executionContext) {
      executionContext.registry.lastNotifiedError = new Date();
      await writeRegistry();
    }
  } catch (error) {
    consoleOriginal.error("Error sending slack notification", error);
  }

  // Re-throws the original error
  throw e;
}

/**
 * Utility function to handle promise, so they are logged in case of an error. It will return a promise that resolves to true if the promise is successful
 * @param errorMessage message to log in case of an error (together with the original error)
 * @param promise original promise
 * @returns a promise that returns true if the original promise was successful
 */
function handlePromiseErrors<T>(
  errorMessage: string,
  promise: Promise<T>
): Promise<boolean> {
  return promise
    .then(() => true)
    .catch((error) => {
      console.error(errorMessage, error);
      return false;
    });
}

/**
 * Convenient utility to log in case theres an error writing in the registry and return a boolean with the result of the operation
 *
 * @param registry Tenderly registry
 * @returns a promise that returns true if the registry write was successful
 */
export async function writeRegistry(): Promise<boolean> {
  if (executionContext) {
    return handlePromiseErrors(
      "Error writing registry",
      executionContext.registry.write()
    );
  }

  return true;
}

export function toChainId(network: string): SupportedChainId {
  const neworkId = Number(network);
  const chainId = ALL_SUPPORTED_CHAIN_IDS.find((chain) => chain === neworkId);
  if (!chainId) {
    throw new Error(`Invalid network: ${network}`);
  }
  return chainId;
}

var consoleOriginal = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
};

// TODO: Delete this code after we sort out the Tenderly log limit issue
// /**
//  * Tenderly has a limit of 4Kb per log message. When you surpass this limit, the log is not printed any more making it super hard to debug anything
//  *
//  * This tool will print
//  *
//  * @param data T
//  */
// const logWithLimit =
//   (level: "log" | "warn" | "error" | "debug") =>
//   (...data: any[]) => {
//     const bigLogText = data
//       .map((item) => {
//         if (typeof item === "string") {
//           return item;
//         }
//         return JSON.stringify(item, null, 2);
//       })
//       .join(" ");

//     const numChunks = Math.ceil(bigLogText.length / TENDERLY_LOG_LIMIT);

//     for (let i = 0; i < numChunks; i += 1) {
//       const chartStart = i * TENDERLY_LOG_LIMIT;
//       const prefix = numChunks > 1 ? `[${i + 1}/${numChunks}] ` : "";
//       const message =
//         prefix +
//         bigLogText.substring(chartStart, chartStart + TENDERLY_LOG_LIMIT);
//       consoleOriginal[level](message);

//       // if (level === "error") {
//       //   sendSlack(message);
//       // }

//       // // Used to debug the Tenderly log Limit issues
//       // consoleOriginal[level](
//       //   prefix + "TEST for bigLogText of " + bigLogText.length + " bytes"
//       // );
//     }
//   };

// Override the log function since some internal libraries might print something and breaks Tenderly

// console.warn = logWithLimit("warn");
// console.error = logWithLimit("error");
// console.debug = logWithLimit("debug");
// console.log = logWithLimit("log");

export function sendSlack(message: string): boolean {
  if (!executionContext) {
    consoleOriginal.warn(
      "[sendSlack] Slack not initialized, ignoring message",
      message
    );
    return false;
  }

  const { slack, registry, notificationsEnabled } = executionContext;

  // Do not notify IF notifications are disabled
  if (!notificationsEnabled || !slack) {
    return false;
  }

  if (registry.lastNotifiedError !== null) {
    const nextErrorNotificationTime =
      registry.lastNotifiedError.getTime() + NOTIFICATION_WAIT_PERIOD;
    if (Date.now() < nextErrorNotificationTime) {
      console.warn(
        `[sendSlack] Last error notification happened earlier than ${
          NOTIFICATION_WAIT_PERIOD / 60_000
        } minutes ago. Next notification will happen after ${new Date(
          nextErrorNotificationTime
        )}`
      );
      return false;
    }
  }

  slack.send({
    text: message,
  });
  return true;
}

/**
 * Attempts to verify that the contract at the given address implements the interface of the `ComposableCoW`
 * contract. This is done by checking that the contract contains the selectors of the functions that are
 * required to be implemented by the interface.
 *
 * @remarks This is not a foolproof way of verifying that the contract implements the interface, but it is
 * a good enough heuristic to filter out most of the contracts that do not implement the interface.
 *
 * @dev The selectors are:
 * - `cabinet(address,bytes32)`: `1c7662c8`
 * - `getTradeableOrderWithSignature(address,(address,bytes32,bytes),bytes,bytes32[])`: `26e0a196`
 *
 * @param code the contract's deployed bytecode as a hex string
 * @returns A boolean indicating if the contract likely implements the interface
 */
export function isComposableCowCompatible(code: string): boolean {
  const composableCow = ComposableCoW__factory.createInterface();

  return REQUIRED_SELECTORS.every((signature) => {
    const sighash = composableCow.getSighash(signature);
    return code.includes(sighash.slice(2));
  });
}

type ParsedError = {
  errorNameOrSelector?: string;
  message?: string;
}

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and optionally a message.
 * @param abi of the custom error, which may or may not be parameterised.
 * @returns an empty parsed error if assumptions don't hold, otherwise the selector and message if applicable.
 */
const rawErrorDecode = (abi: string): ParsedError  => {
  if (abi.length === 10) {
    return { errorNameOrSelector: abi }
  } else {
    try {
      const selector = abi.slice(0, 10);
      const message = ethers.utils.defaultAbiCoder.decode(
        ["string"],
        '0x' + abi.slice(10) // trim off the selector
      )[0];
      return { errorNameOrSelector: selector, message };
    } catch {
      // some weird parameter, just return and let the caller deal with it
      return {};
    }  
  }
}

/**
 * Parse custom reversion errors, irrespective of the RPC node's software
 * 
 * Background: `ComposableCoW` makes extensive use of `revert` to provide custom error messages. Unfortunately,
 *             different RPC nodes handle these errors differently. For example, Nethermind returns a zero-bytes
 *             `error.data` in all cases, and the error selector is buried in `error.error.error.data`. Other 
 *             nodes return the error selector in `error.data`.
 * 
 *             In all cases, if the error selector contains a parameterised error message, the error message is
 *             encoded in the `error.data` field. For example, `OrderNotValid` contains a parameterised error
 *             message, and the error message is encoded in `error.data`.
 * 
 * Assumptions:
 * - `error.data` exists for all tested RPC nodes, and parameterised / non-parameterised custom errors.
 * - All calls to the smart contract if they revert, return a non-zero result at **EVM** level.
 * - Nethermind, irrespective of the revert reason, returns a zero-bytes `error.data` due to odd message
 *   padding on the RPC return value from Nethermind.
 * Therefore:
 * - Nethermind: `error.data` in a revert case is `0x` (empty string), with the revert reason buried in
 *   `error.error.error.data`.
 * - Other nodes: `error.data` in a revert case we expected the revert reason / custom error selector.
 * @param error returned by ethers
 */
export const parseCustomError = (error: any): ParsedError => {
  const { errorName, data } = error;

  // In all cases, data must be defined. If it isn't, return early - bad assumptions.
  if (!data) {
    return {};
  }

  // If error.errorName is defined:
  // - The node has formatted the error message in a way that ethers can parse
  // - It's not a parameterised custom error - no message
  // - We can return early
  if (errorName) {
    return { errorNameOrSelector: errorName };
  }

  // If error.data is not zero-bytes, then it's not a Nethermind node, assume it's a string parameterised
  // custom error. Attempt to decode and return.
  if (data !== "0x") {
    return rawErrorDecode(data)
  } else {
    // This is a Nethermind node, as `data` *must* be equal to `0x`, but we know we always revert with an
    // message, so - we have to go digging ⛏️🙄
    //
    // Verify our assumption that `error.error.error.data` is defined and is a string.
    const rawNethermind = error?.error?.error?.data
    if (typeof rawNethermind === "string") {
      // For some reason, Nethermind pad their message with `Reverted `, so, we need to slice off the 
      // extraneous part of the message, and just get the data - that we wanted in the first place!
      const nethermindData = rawNethermind.slice('Reverted '.length)
      return rawErrorDecode(nethermindData)
    } else {
      // the nested error-ception for some reason failed and our assumptions are therefore incorrect.
      // return the unknown state to the caller.
      return {}
    }
  }
}

export class LowLevelError extends Error {
  data: string;
  constructor(msg: string, data: string) {
    super(msg);
    this.data = data;
    Object.setPrototypeOf(this, LowLevelError.prototype);
  }
}