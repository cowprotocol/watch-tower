import Slack = require("node-slack");
import { backOff } from "exponential-backoff";
import DBService from "./db";

import {
  init as sentryInit,
  startTransaction as sentryStartTransaction,
  Transaction as SentryTransaction,
} from "@sentry/node";
import { CaptureConsole as CaptureConsoleIntegration } from "@sentry/integrations";

import { ExecutionContext, Registry } from "../types/model";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { initLogging } from "./logging";
import { SingularRunOptions } from "../types";

const NOTIFICATION_WAIT_PERIOD = 1000 * 60 * 60 * 2; // 2h - Don't send more than one notification every 2h

let executionContext: ExecutionContext | undefined;

export async function initContext(
  transactionName: string,
  chainId: SupportedChainId,
  options: SingularRunOptions
): Promise<ExecutionContext> {
  // Init Logging
  _initLogging(transactionName, chainId, options);

  // Init storage
  const storage = DBService.getInstance();

  // Init registry
  const registry = await Registry.load(
    storage,
    chainId.toString(),
    Number(options.deploymentBlock)
  );

  // Init slack
  const slack = _getSlack(options);

  // Init Sentry
  const sentryTransaction = _getSentry(transactionName, chainId, options);
  if (!sentryTransaction) {
    console.warn("SENTRY_DSN secret is not set. Sentry will be disabled");
  }

  executionContext = {
    registry,
    slack,
    sentryTransaction,
    notificationsEnabled: !options.silent,
    storage,
  };

  return executionContext;
}

function _getSlack(options: SingularRunOptions): Slack | undefined {
  if (executionContext) {
    return executionContext?.slack;
  }

  // Init slack
  const webhookUrl = options.slackWebhook || "";

  if (options.silent && !webhookUrl) {
    return undefined;
  }

  if (!webhookUrl) {
    throw new Error(
      "SLACK_WEBHOOK_URL must be set if not running in silent mode"
    );
  }

  return new Slack(webhookUrl);
}

function _getSentry(
  transactionName: string,
  chainId: SupportedChainId,
  options: SingularRunOptions
): SentryTransaction | undefined {
  // Init Sentry
  if (!executionContext) {
    const sentryDsn = options.sentryDsn || "";
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
    console.error("Error sending slack notification", error);
  }

  // Re-throws the original error
  throw e;
}

export function sendSlack(message: string): boolean {
  if (!executionContext) {
    console.warn(
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
 * Convenient utility to log in case theres an error writing in the registry and return a boolean with the result of the operation
 *
 * @param registry Tenderly registry
 * @returns a promise that returns true if the registry write was successful
 */
export async function writeRegistry(): Promise<boolean> {
  if (executionContext) {
    return handlePromiseErrors(
      "Error writing registry. Not more attempts!",
      backOff(
        async () => {
          if (!executionContext) {
            return undefined;
          }
          return executionContext.registry.write();
        },
        {
          numOfAttempts: 10,
          timeMultiple: 2,
          retry: (e, attemptNumber) => {
            console.warn(
              `Error writing registry. Attempt ${attemptNumber}. Retrying...`,
              e
            );
            return true;
          },
        }
      ).catch((e) => {
        if (executionContext) {
          console.error(
            "Error writing registry. Not more attempts! Dumping the orders",
            executionContext.registry.stringifyOrders()
          );
        }
        throw e;
      })
    );
  }

  return true;
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
 * Init Logging with Loggly
 */
function _initLogging(
  transactionName: string,
  chainId: SupportedChainId,
  options: SingularRunOptions
) {
  const { logglyToken } = options;
  if (logglyToken) {
    initLogging(logglyToken, [transactionName, `chain_${chainId}`]);
  } else {
    console.warn("LOGGLY_TOKEN is not set, logging to console only");
  }
}
