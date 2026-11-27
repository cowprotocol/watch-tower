import {
  OrderBookApiError,
  OrderPostError,
  OrderStatus as ApiOrderStatus,
} from "@cowprotocol/sdk-order-book";
import { PollResultCode, PollResultErrors } from "@cowprotocol/sdk-composable";
import { constants as httpStatus } from "node:http2";

import type { ChainContext } from "../../services";
import type { AaveOrderAttempt, ConditionalOrder } from "../../types";
import { TimeoutError, withTimeout } from "../../utils";
import * as metrics from "../../utils/metrics";
import {
  AAVE_ORDER_VALIDITY_SECONDS,
  AAVE_ORDERBOOK_TIMEOUT_MS,
  SINGLE_ORDERBOOK_ATTEMPT,
} from "../aaveProtectionQuote";

export const MIN_ORDER_VALIDITY_SECONDS = 60;
const DEFAULT_ORDERBOOK_RETRY_SECONDS = 30;
const ORDER_STATUS_GRACE_SECONDS = 30;
// The pinned Node types do not include this status.
const HTTP_STATUS_TOO_EARLY = 425;
const ApiErrors = OrderPostError.errorType;
const REQUOTE_ERRORS = new Set([
  ApiErrors.QUOTE_NOT_FOUND,
  ApiErrors.INVALID_QUOTE,
  ApiErrors.INSUFFICIENT_VALID_TO,
  ApiErrors.INVALID_EIP1271SIGNATURE,
  // The orderbook can fall back to a plain allowance check if simulation fails.
  ApiErrors.INSUFFICIENT_ALLOWANCE,
]);

export function retry(reason: string): PollResultErrors {
  return { result: PollResultCode.TRY_NEXT_BLOCK, reason };
}

export function stop(reason: string): PollResultErrors {
  return { result: PollResultCode.DONT_TRY_AGAIN, reason };
}

export function retryAt(epoch: number, reason: string): PollResultErrors {
  return { result: PollResultCode.TRY_AT_EPOCH, epoch, reason };
}

export function apiErrorReason(error: unknown) {
  if (error instanceof OrderBookApiError) {
    return `HTTP ${error.response.status} ${JSON.stringify(error.body)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function orderBookTime(blockTimestamp: number) {
  // Order admission checks wall-clock time, which may be ahead of this block.
  return Math.max(blockTimestamp, Math.floor(Date.now() / 1000));
}

export function retryAfterEpoch(
  error: unknown,
  blockTimestamp: number,
  validUntil?: number
): number | undefined {
  if (!(error instanceof OrderBookApiError)) return;
  const { status, headers } = error.response;
  const header = headers.get("retry-after")?.trim() ?? "";
  if (
    status !== httpStatus.HTTP_STATUS_TOO_MANY_REQUESTS &&
    !(status === httpStatus.HTTP_STATUS_SERVICE_UNAVAILABLE && header)
  ) {
    return;
  }
  const now = orderBookTime(blockTimestamp);
  const seconds = /^\d+$/.test(header)
    ? Number(header)
    : /[a-z]/i.test(header)
    ? Math.ceil(Date.parse(header) / 1000) - now
    : NaN;
  const delay = Number.isNaN(seconds)
    ? DEFAULT_ORDERBOOK_RETRY_SECONDS
    : seconds;
  return Math.min(
    validUntil ?? now + AAVE_ORDER_VALIDITY_SECONDS,
    now + Math.max(1, delay)
  );
}

function httpTimeout(deadline = Infinity) {
  return Math.min(deadline - Date.now(), AAVE_ORDERBOOK_TIMEOUT_MS);
}

function canPost(validTo: number, blockTimestamp: number, timeout: number) {
  return (
    timeout > 0 &&
    validTo - orderBookTime(blockTimestamp) > MIN_ORDER_VALIDITY_SECONDS
  );
}

function markAccepted(attempt: AaveOrderAttempt, metricLabels?: string[]) {
  if (attempt.state !== "accepted" && metricLabels) {
    metrics.orderBookDiscreteOrdersTotal.labels(...metricLabels).inc();
  }
  attempt.state = "accepted";
  delete attempt.payload;
}

function markLookupOnly(attempt: AaveOrderAttempt) {
  attempt.state = "lookup-only";
  delete attempt.payload;
}

function matchesUid(uid: string, returnedUid: unknown) {
  return (
    typeof returnedUid === "string" &&
    returnedUid.toLowerCase() === uid.toLowerCase()
  );
}

function trackPostError(
  metricLabels: string[] | undefined,
  status: string | number,
  errorType: string
) {
  if (metricLabels)
    metrics.orderBookErrorsTotal
      .labels(...metricLabels, String(status), errorType)
      .inc();
}

async function postSavedOrder(
  { orderBookApi }: ChainContext,
  attempt: AaveOrderAttempt,
  blockTimestamp: number,
  metricLabels?: string[],
  deadline?: number
): Promise<PollResultErrors | OrderBookApiError | undefined> {
  const { uid, validTo, payload } = attempt;
  const timeout = httpTimeout(deadline);
  if (!payload || !canPost(validTo, blockTimestamp, timeout)) return;

  try {
    const returnedUid = await withTimeout(
      orderBookApi.sendOrder(payload, SINGLE_ORDERBOOK_ATTEMPT),
      timeout,
      "Aave sendOrder"
    );
    if (!matchesUid(uid, returnedUid)) {
      markLookupOnly(attempt);
      trackPostError(metricLabels, "response", "UidMismatch");
      return retry(
        `Aave orderbook returned UID ${returnedUid}, expected ${uid}`
      );
    }
    markAccepted(attempt, metricLabels);
    return retryAt(validTo, `Aave protection order ${uid} accepted`);
  } catch (error) {
    const reason = `Aave order ${uid}: ${apiErrorReason(error)}`;
    if (error instanceof OrderBookApiError) {
      const { status } = error.response;
      const errorType = (error.body as OrderPostError | undefined)?.errorType;
      trackPostError(metricLabels, status, errorType ?? "Unknown");
      const cooldown = retryAfterEpoch(
        error,
        blockTimestamp,
        validTo + ORDER_STATUS_GRACE_SECONDS
      );
      if (cooldown !== undefined) return retryAt(cooldown, reason);
      if (
        status >= httpStatus.HTTP_STATUS_BAD_REQUEST &&
        status < httpStatus.HTTP_STATUS_INTERNAL_SERVER_ERROR &&
        status !== httpStatus.HTTP_STATUS_REQUEST_TIMEOUT &&
        status !== HTTP_STATUS_TOO_EARLY &&
        errorType !== ApiErrors.DUPLICATED_ORDER
      ) {
        return error;
      }
    } else if (error instanceof TimeoutError) {
      trackPostError(metricLabels, "timeout", "Timeout");
    } else {
      trackPostError(metricLabels, "request", "Unknown");
    }
    return retry(`${reason}. Check the same UID on the next poll.`);
  }
}

export async function submitOrder(
  context: ChainContext,
  conditionalOrder: ConditionalOrder,
  attempt: AaveOrderAttempt,
  blockTimestamp: number,
  metricLabels?: string[],
  deadline?: number
): Promise<PollResultErrors> {
  conditionalOrder.aaveOrderAttempt = attempt;
  try {
    // Recovery needs the exact order even if the POST outlives its local timeout.
    await context.registry.write();
  } catch (error) {
    delete conditionalOrder.aaveOrderAttempt;
    throw error;
  }

  const result = await postSavedOrder(
    context,
    attempt,
    blockTimestamp,
    metricLabels,
    deadline
  );
  if (result && !(result instanceof OrderBookApiError)) return result;

  // A skipped POST or definitive first rejection leaves no prior send in flight.
  delete conditionalOrder.aaveOrderAttempt;
  if (!result)
    return retry(
      "Aave order validity or polling deadline elapsed before submission"
    );

  const errorType = (result.body as OrderPostError | undefined)?.errorType;
  const reason = `Aave order ${attempt.uid} rejected: ${apiErrorReason(
    result
  )}`;
  return errorType && REQUOTE_ERRORS.has(errorType)
    ? retryAt(
        orderBookTime(blockTimestamp) + DEFAULT_ORDERBOOK_RETRY_SECONDS,
        reason
      )
    : stop(reason);
}

export async function pollTrackedOrder(
  context: ChainContext,
  attempt: AaveOrderAttempt,
  blockTimestamp: number,
  canResend: () => Promise<boolean>,
  metricLabels?: string[],
  deadline?: number
): Promise<PollResultErrors> {
  const { uid, validTo } = attempt;
  const trackingUntil = validTo + ORDER_STATUS_GRACE_SECONDS;
  const now = orderBookTime(blockTimestamp);
  if (now >= trackingUntil)
    return stop(`Aave order ${uid} tracking window elapsed`);
  if (attempt.state === "accepted" && now < validTo) {
    return retryAt(validTo, `Aave protection order ${uid} accepted`);
  }

  const timeout = httpTimeout(deadline);
  if (timeout <= 0) return retry(`Aave order ${uid} lookup budget elapsed`);

  // A timed-out POST may already have reached the orderbook.
  try {
    const { uid: returnedUid, status } = await withTimeout(
      context.orderBookApi.getOrder(uid, SINGLE_ORDERBOOK_ATTEMPT),
      timeout,
      "Aave getOrder"
    );
    if (!matchesUid(uid, returnedUid)) {
      return retry(
        `Aave orderbook returned UID ${returnedUid}, expected ${uid}`
      );
    }

    markAccepted(attempt, metricLabels);
    const reason = `Aave protection order ${uid} ${status}`;
    if (
      status === ApiOrderStatus.FULFILLED ||
      status === ApiOrderStatus.CANCELLED
    ) {
      return stop(reason);
    }
    // The orderbook can report expiry before it indexes a fill.
    return now < validTo ? retryAt(validTo, reason) : retry(reason);
  } catch (error) {
    if (
      !(error instanceof OrderBookApiError) ||
      error.response.status !== httpStatus.HTTP_STATUS_NOT_FOUND
    ) {
      const reason = `Aave order ${uid} lookup failed: ${apiErrorReason(
        error
      )}`;
      const cooldown = retryAfterEpoch(error, blockTimestamp, trackingUntil);
      return cooldown === undefined ? retry(reason) : retryAt(cooldown, reason);
    }
  }

  // A rejection of a resend cannot resolve the outcome of the original POST.
  if (
    attempt.state !== "pending" ||
    !canPost(validTo, blockTimestamp, httpTimeout(deadline)) ||
    !(await canResend())
  ) {
    return retry(`Aave order ${uid} is not visible yet`);
  }

  const result = await postSavedOrder(
    context,
    attempt,
    blockTimestamp,
    metricLabels,
    deadline
  );
  if (!(result instanceof OrderBookApiError)) {
    return result ?? retry(`Aave order ${uid} is not visible yet`);
  }
  markLookupOnly(attempt);
  await context.registry.write();
  return retry(
    `Aave resend rejected. Keep looking up ${uid}: ${apiErrorReason(result)}`
  );
}
