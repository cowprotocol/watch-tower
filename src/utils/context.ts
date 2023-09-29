import Slack = require("node-slack");
import { DBService } from "./db";

import { ExecutionContext, Registry, SingularRunOptions } from "../types";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { getLogger } from "./logging";

const NOTIFICATION_WAIT_PERIOD = 1000 * 60 * 60 * 2; // 2h - Don't send more than one notification every 2h

let executionContext: ExecutionContext | undefined;

export async function initContext(
  transactionName: string,
  chainId: SupportedChainId,
  options: SingularRunOptions
): Promise<ExecutionContext> {
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

  executionContext = {
    registry,
    slack,
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

export async function handleExecutionError(e: any) {
  const log = getLogger("context:handleExecutionError");
  try {
    const errorMessage = e?.message || "Unknown error";
    const notified = sendSlack(
      errorMessage +
        ". More info https://dashboard.tenderly.co/devcow/project/actions"
    );

    if (notified && executionContext) {
      executionContext.registry.lastNotifiedError = new Date();
      await executionContext.registry.write();
    }
  } catch (error) {
    log.error("Error sending slack notification", error);
  }

  // Re-throws the original error
  throw e;
}

export function sendSlack(message: string): boolean {
  const log = getLogger("context:sendSlack");
  if (!executionContext) {
    log.warn("Slack not initialized, ignoring message", message);
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
      log.warn(
        `Last error notification happened earlier than ${
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
