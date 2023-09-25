import Slack = require("node-slack");
import { Context } from "@tenderly/actions";
import { backOff } from "exponential-backoff";

import {
  init as sentryInit,
  startTransaction as sentryStartTransaction,
  Transaction as SentryTransaction,
} from "@sentry/node";
import { CaptureConsole as CaptureConsoleIntegration } from "@sentry/integrations";

import { ExecutionContext, Registry } from "../model";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { initLogging } from "./logging";

const NOTIFICATION_WAIT_PERIOD = 1000 * 60 * 60 * 2; // 2h - Don't send more than one notification every 2h

let executionContext: ExecutionContext | undefined;

export async function initContext(
  transactionName: string,
  chainId: SupportedChainId,
  context: Context
): Promise<ExecutionContext> {
  // Get environment
  const env = await getEnv(context);

  // Get shadow mode
  const isShadowMode = await getIsShadowMode(context);

  // Init Logging
  await _initLogging(transactionName, chainId, context, env, isShadowMode);

  // Init registry
  const registry = await Registry.load(context, chainId.toString());

  // Get notifications config (enabled by default)
  const notificationsEnabled = await _getNotificationsEnabled(context);

  // Init slack
  const slack = await _getSlack(notificationsEnabled, context);

  // Init Sentry
  const sentryTransaction = await _getSentry(transactionName, chainId, context);

  executionContext = {
    env,
    isShadowMode,
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
  const webhookUrl = (
    await context.secrets.get("SLACK_WEBHOOK_URL").catch(() => "")
  ).trim();

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
  const sentryDsn = (
    await context.secrets.get("SENTRY_DSN").catch(() => "")
  ).trim();

  if (!sentryDsn) {
    return undefined;
  }

  // Init Sentry
  if (!executionContext) {
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
async function _initLogging(
  transactionName: string,
  chainId: SupportedChainId,
  context: Context,
  env: string | undefined,
  isShadowMode: boolean
) {
  const logglyToken = (
    await context.secrets.get("LOGGLY_TOKEN").catch(() => "")
  ).trim();

  if (logglyToken) {
    const envTag = (isShadowMode ? "shadow" : "live") + (env ? `_${env}` : "");
    initLogging(logglyToken, [envTag, `chain_${chainId}`, transactionName]);
  }
}

/**
 * Return then environment. If not set, it will return undefined
 */
async function getEnv(context: Context): Promise<string | undefined> {
  return (
    (await context.secrets.get("NODE_ENV").catch(() => "")).trim() || undefined
  );
}

/**
 * Whether the watch tower will run in shadow mode. False by default
 */
async function getIsShadowMode(context: Context): Promise<boolean> {
  return (
    (await context.secrets.get("SHADOW_MODE").catch(() => "")).trim() === "true"
  );
}
