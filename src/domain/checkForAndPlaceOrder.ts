import {
  Order,
  OrderBalance,
  OrderKind,
  computeOrderUid,
} from "@cowprotocol/contracts";

import { ethers } from "ethers";
import { BytesLike } from "ethers/lib/utils";

import { ConditionalOrder, OrderStatus } from "../types";
import {
  LowLevelError,
  formatStatus,
  getLogger,
  pollConditionalOrder,
  customErrorDecode,
} from "../utils";
import {
  OrderBookApi,
  OrderCreation,
  OrderPostError,
  PollParams,
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  SupportedChainId,
  formatEpoch,
} from "@cowprotocol/cow-sdk";
import { ChainContext } from "./chainContext";
import { MetricsService } from "../utils/metrics";

const {
  orderBookOrdersPlaced,
  orderBookApiErrors,
  pollingOnChainChecks,
  pollingOnChainTimer,
  pollingUnexpectedErrors,
  pollingChecks,
} = MetricsService;

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

const ApiErrors = OrderPostError.errorType;
type NextBlockApiErrorsArray = Array<OrderPostError.errorType>;
type BackOffApiErrorsDelays = {
  [K in OrderPostError.errorType]?: number;
};

/**
 * Handle error that will return `TRY_NEXT_BLOCK`, so it doesn't throw but is re-attempted on next block
 */
const API_ERRORS_TRY_NEXT_BLOCK: NextBlockApiErrorsArray = [
  ApiErrors.INSUFFICIENT_FEE,
];

const TEN_MINS = 10 * 60;
const API_ERRORS_BACKOFF: BackOffApiErrorsDelays = {
  [ApiErrors.INSUFFICIENT_ALLOWANCE]: TEN_MINS,
  [ApiErrors.INSUFFICIENT_BALANCE]: TEN_MINS,
};

/**
 * Watch for new blocks and check for orders to place
 *
 * @param context tenderly context
 * @param event block event
 */
export async function checkForAndPlaceOrder(
  context: ChainContext,
  block: ethers.providers.Block,
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { chainId, registry } = context;
  const { ownerOrders, numOrders } = registry;

  const blockNumber = blockNumberOverride || block.number;
  const blockTimestamp = blockTimestampOverride || block.timestamp;

  let hasErrors = false;
  let ownerCounter = 0;
  let orderCounter = 0;

  const logPrefix = `checkForAndPlaceOrder:${chainId}:${blockNumber}`;
  const log = getLogger(logPrefix);
  log.debug(`Total number of orders: ${numOrders}`);

  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCounter++;
    const log = getLogger(`${logPrefix}:${ownerCounter}`);
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    log.debug(
      `Process owner ${owner} (${conditionalOrders.size} orders): ${registry.numOrders}`
    );
    for (const conditionalOrder of conditionalOrders) {
      orderCounter++;
      const ownerRef = `${ownerCounter}.${orderCounter}`;
      const orderRef = `${chainId}:${ownerRef}@${blockNumber}`;
      const log = getLogger(`${logPrefix}:${ownerRef}}`);
      const logOrderDetails = `Processing order from TX ${conditionalOrder.tx} with params:`;

      const { result: lastHint } = conditionalOrder.pollResult || {};

      // Check if the order is due (by epoch)
      if (
        lastHint?.result === PollResultCode.TRY_AT_EPOCH &&
        blockTimestamp < lastHint.epoch
      ) {
        log.debug(
          `Skipping conditional. Reason: Not due yet (TRY_AT_EPOCH=${
            lastHint.epoch
          }, ${formatEpoch(lastHint.epoch)}). ${logOrderDetails}`,
          conditionalOrder.params
        );
        continue;
      }

      // Check if the order is due (by blockNumber)
      if (
        lastHint?.result === PollResultCode.TRY_ON_BLOCK &&
        blockNumber < lastHint.blockNumber
      ) {
        log.debug(
          `Skipping conditional. Reason: Not due yet (TRY_ON_BLOCK=${
            lastHint.blockNumber
          }, in ${
            lastHint.blockNumber - blockNumber
          } blocks). ${logOrderDetails}`,
          conditionalOrder.params
        );
        continue;
      }

      // Proceed with the normal check
      log.info(`${logOrderDetails}`, conditionalOrder.params);

      const pollResult = await _processConditionalOrder(
        owner,
        conditionalOrder,
        blockTimestamp,
        blockNumber,
        context,
        orderRef
      );

      // Don't try again the same order, in case that's the poll result
      if (pollResult.result === PollResultCode.DONT_TRY_AGAIN) {
        ordersPendingDelete.push(conditionalOrder);
      }

      // Save the latest poll result
      conditionalOrder.pollResult = {
        lastExecutionTimestamp: blockTimestamp,
        blockNumber: blockNumber,

        result: pollResult,
      };

      // Log the result
      const unexpectedError =
        pollResult?.result === PollResultCode.UNEXPECTED_ERROR;

      // Print the polling result
      const isError = pollResult.result !== PollResultCode.SUCCESS;
      const resultDescription =
        pollResult.result +
        (isError && pollResult.reason ? `. Reason: ${pollResult.reason}` : "");

      log[unexpectedError ? "error" : "info"](
        `Check conditional order result: ${getEmojiByPollResult(
          pollResult?.result
        )} ${resultDescription}`
      );
      if (unexpectedError) {
        log.error(`UNEXPECTED_ERROR Details:`, pollResult.error);
      }

      hasErrors ||= unexpectedError;
    }

    // Delete orders we don't want to keep watching
    for (const conditionalOrder of ordersPendingDelete) {
      const deleted = conditionalOrders.delete(conditionalOrder);
      const action = deleted ? "Stop Watching" : "Failed to stop watching";

      log.debug(`${action} conditional order from TX ${conditionalOrder.tx}`);
    }
  }

  // It may be handy in other versions of the watch tower implemented in other languages
  // (ie. not for Tenderly) to not delete owners, so we can keep track of them.
  for (const [owner, conditionalOrders] of Array.from(ownerOrders.entries())) {
    if (conditionalOrders.size === 0) {
      ownerOrders.delete(owner);
    }
  }

  // save the registry - don't catch errors here, as it's now a docker container
  // and we want to crash if there's an error
  await registry.write();

  log.debug(
    `Total orders after processing all conditional orders: ${registry.numOrders}`
  );

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(`At least one unexpected error processing conditional orders`);
  }
}
async function _processConditionalOrder(
  owner: string,
  conditionalOrder: ConditionalOrder,
  blockTimestamp: number,
  blockNumber: number,
  context: ChainContext,
  orderRef: string
): Promise<PollResult> {
  const { provider, orderBook, dryRun, chainId } = context;
  const log = getLogger(
    `checkForAndPlaceOrder:_processConditionalOrder:${orderRef}`
  );
  try {
    pollingChecks.labels(chainId.toString()).inc();

    const proof = conditionalOrder.proof
      ? conditionalOrder.proof.path.map((c) => c.toString())
      : [];
    const offchainInput = "0x";

    const pollParams: PollParams = {
      owner,
      chainId,
      proof,
      offchainInput,
      blockInfo: {
        blockTimestamp,
        blockNumber,
      },
      provider,
    };
    let pollResult = await pollConditionalOrder(
      pollParams,
      conditionalOrder.params,
      orderRef
    );

    if (!pollResult) {
      // Unsupported Order Type (unknown handler)
      // For now, fallback to legacy behavior
      // TODO: Decide in the future what to do. Probably, move the error handling to the SDK and kill the poll Legacy
      const timer = pollingOnChainTimer.labels(chainId.toString()).startTimer();
      pollResult = await _pollLegacy(
        context,
        owner,
        conditionalOrder,
        proof,
        offchainInput,
        orderRef
      );
      timer();
      pollingOnChainChecks.labels(chainId.toString()).inc();
    }

    // Error polling
    if (pollResult.result !== PollResultCode.SUCCESS) {
      return pollResult;
    }

    const { order, signature } = pollResult;

    const orderToSubmit: Order = {
      ...order,
      kind: kindToString(order.kind.toString()),
      sellTokenBalance: balanceToString(order.sellTokenBalance.toString()),
      buyTokenBalance: balanceToString(order.buyTokenBalance.toString()),
      validTo: Number(order.validTo),
    };

    // calculate the orderUid
    const orderUid = _getOrderUid(chainId, orderToSubmit, owner);

    // Place order, if the orderUid has not been submitted or filled
    if (!conditionalOrder.orders.has(orderUid)) {
      // Place order
      const placeOrderResult = await _placeOrder({
        orderUid,
        order: { ...orderToSubmit, from: owner, signature },
        orderBook,
        blockTimestamp,
        orderRef,
        dryRun,
      });

      // In case of error, return early
      if (placeOrderResult.result !== PollResultCode.SUCCESS) {
        return placeOrderResult;
      }

      // Mark order as submitted
      conditionalOrder.orders.set(orderUid, OrderStatus.SUBMITTED);
    } else {
      const orderStatus = conditionalOrder.orders.get(orderUid);
      log.info(
        `OrderUid ${orderUid} status: ${
          orderStatus ? formatStatus(orderStatus) : "Not found"
        }`
      );
    }

    // Success!
    return {
      result: PollResultCode.SUCCESS,
      order,
      signature,
    };
  } catch (e: any) {
    pollingUnexpectedErrors.labels(chainId.toString()).inc();
    return {
      result: PollResultCode.UNEXPECTED_ERROR,
      error: e,
      reason:
        "Unhandled error processing conditional order" +
        (e.message ? `: ${e.message}` : ""),
    };
  }
}

function _getOrderUid(
  chainId: SupportedChainId,
  orderToSubmit: Order,
  owner: string
) {
  return computeOrderUid(
    {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: chainId,
      verifyingContract: GPV2SETTLEMENT,
    },
    {
      ...orderToSubmit,
      receiver:
        orderToSubmit.receiver === ethers.constants.AddressZero
          ? undefined
          : orderToSubmit.receiver,
    },
    owner
  );
}

/**
 * Print a list of all the orders that were placed and not filled
 *
 * @param orders All the orders that are being tracked
 */
export const _printUnfilledOrders = (orders: Map<BytesLike, OrderStatus>) => {
  const unfilledOrders = Array.from(orders.entries())
    .filter(([_orderUid, status]) => status === OrderStatus.SUBMITTED) // as SUBMITTED != FILLED
    .map(([orderUid, _status]) => orderUid)
    .join(", ");

  if (unfilledOrders) {
    console.log(`Unfilled Orders: `, unfilledOrders);
  }
};

/**
 * Place a new order
 * @param order to be placed on the cow protocol api
 * @param apiUrl rest api url
 */
async function _placeOrder(params: {
  orderUid: string;
  order: any;
  orderBook: OrderBookApi;
  orderRef: string;
  blockTimestamp: number;
  dryRun: boolean;
}): Promise<Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors> {
  const { orderUid, order, orderBook, orderRef, blockTimestamp, dryRun } =
    params;
  const log = getLogger(`checkForAndPlaceOrder:_placeOrder:${orderRef}`);
  const { chainId } = orderBook.context;
  try {
    const postOrder: OrderCreation = {
      ...order,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      feeAmount: order.feeAmount.toString(),
      signingScheme: "eip1271",
    };

    // If the operation is a dry run, don't post to the API
    log.info(`Post order ${orderUid} to OrderBook on chain ${chainId}`);
    log.debug(`Order`, postOrder);
    if (!dryRun) {
      const orderUid = await orderBook.sendOrder(postOrder);
      orderBookOrdersPlaced.labels(chainId.toString()).inc();
      log.info(`API response`, { orderUid });
    }
  } catch (error: any) {
    let reasonError = "Error placing order in API";
    if (error.response) {
      const { status } = error.response;
      const { body } = error;

      const handleErrorResult = _handleOrderBookError(
        status,
        body,
        error,
        chainId,
        blockTimestamp
      );
      const isSuccess = handleErrorResult.result === PollResultCode.SUCCESS;

      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      log[isSuccess ? "warn" : "error"](
        `Error placing order in API. Result: ${status}`,
        body
      );

      if (isSuccess) {
        log.debug(`All good! continuing with warnings...`);
        return { result: PollResultCode.SUCCESS };
      } else {
        return handleErrorResult;
      }
    } else if (error.request) {
      // The request was made but no response was received
      // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
      // http.ClientRequest in node.js
      reasonError += `Unresponsive API: ${error.request}`;
    } else if (error.message) {
      // Something happened in setting up the request that triggered an Error
      reasonError += `. Internal Error: ${error.request}`;
    } else {
      reasonError += `. Unhandled Error: ${error.message}`;
    }

    return {
      result: PollResultCode.UNEXPECTED_ERROR,
      reason: reasonError,
      error,
    };
  }

  return { result: PollResultCode.SUCCESS };
}

function _handleOrderBookError(
  status: any,
  body: any,
  error: any,
  chainId: SupportedChainId,
  blockTimestamp: number
): Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors {
  const apiError = body?.errorType as OrderPostError.errorType;
  orderBookApiErrors
    .labels(chainId.toString(), status.toString(), apiError)
    .inc();
  if (status === 400) {
    // The order is in the OrderBook, all good :)
    if (apiError === ApiErrors.DUPLICATE_ORDER) {
      return {
        result: PollResultCode.SUCCESS,
      };
    }

    // It's possible that an order has not enough allowance or balance.
    // Returning DONT_TRY_AGAIN would be to drastic, but we can give the WatchTower a break by scheduling next attempt in a few minutes
    // This why, we don't so it doesn't try in every block
    const backOffDelay = API_ERRORS_BACKOFF[apiError];
    if (backOffDelay) {
      const nextPollTimestamp = blockTimestamp + backOffDelay;
      return {
        result: PollResultCode.TRY_AT_EPOCH,
        epoch: nextPollTimestamp,
        reason: `Not enough allowance/balance (${apiError}). Scheduling next polling in ${Math.floor(
          backOffDelay / 60
        )} minutes, at ${nextPollTimestamp} ${formatEpoch(nextPollTimestamp)}`,
      };
    }

    // Handle some errors, that might be solved in the next block
    if (API_ERRORS_TRY_NEXT_BLOCK.includes(apiError)) {
      return {
        result: PollResultCode.TRY_NEXT_BLOCK,
        reason: `OrderBook API Known Error: ${apiError}, ${body?.description}`,
      };
    }
  }

  return {
    result: PollResultCode.UNEXPECTED_ERROR,
    reason: `OrderBook API Unknown Error: ${apiError}, ${body?.description}`,
    error,
  };
}

async function _pollLegacy(
  context: ChainContext,
  owner: string,
  conditionalOrder: ConditionalOrder,
  proof: string[],
  offchainInput: string,
  orderRef: string
): Promise<PollResult> {
  const { chainId, contract, multicall } = context;
  // as we going to use multicall, with `aggregate3Value`, there is no need to do any simulation as the
  // calls are guaranteed to pass, and will return the results, or the reversion within the ABI-encoded data.
  // By not using `populateTransaction`, we avoid an `eth_estimateGas` RPC call.
  const log = getLogger(`checkForAndPlaceOrder:_pollLegacy:${orderRef}`);
  const to = contract.address;
  const data = contract.interface.encodeFunctionData(
    "getTradeableOrderWithSignature",
    [owner, conditionalOrder.params, offchainInput, proof]
  );

  try {
    const lowLevelCall = await multicall.callStatic.aggregate3Value([
      {
        target: to,
        allowFailure: true,
        value: 0,
        callData: data,
      },
    ]);

    const [{ success, returnData }] = lowLevelCall;

    // If the call failed, there may be a custom error to provide hints. We wrap the error in a LowLevelError
    // so that it can be handled in the catch.
    if (!success) {
      throw new LowLevelError("low-level call failed", returnData);
    }

    // Decode the result to get the order and signature
    const { order, signature } = contract.interface.decodeFunctionResult(
      "getTradeableOrderWithSignature",
      returnData
    );
    return {
      result: PollResultCode.SUCCESS,
      order,
      signature,
    };
  } catch (error: any) {
    log.error(
      `Error on CALL to getTradeableOrderWithSignature. Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${chainId}&contractAddress=${to}&rawFunctionInput=${data}`
    );

    // An error of some type occurred. It may or may not be a hint. We pass it to the handler to decide.
    return _handleGetTradableOrderWithSignatureCall(error, owner, orderRef);
  }
}

function _handleGetTradableOrderWithSignatureCall(
  error: any,
  owner: string,
  orderRef: string
): PollResultErrors {
  const logPrefix = `checkForAndPlaceOrder:_handleGetTradableOrderCall:${orderRef}`;
  const log = getLogger(logPrefix);

  // If the error is a LowLevelError, we extract the selector, and any parameters.
  if (error instanceof LowLevelError) {
    try {
      // The below will throw if:
      // - the error is not a custom error (ie. the selector is not in the map)
      // - the error is a custom error, but the parameters are not as expected
      const { selector, message, blockNumberOrEpoch } = customErrorDecode(
        error.data
      );
      switch (selector) {
        case "SINGLE_ORDER_NOT_AUTHED":
        case "PROOF_NOT_AUTHED":
          // If there's no authorization we delete the order
          // - One reason could be, because the user CANCELLED the order
          // - for now it doesn't support more advanced cases where the order is auth during a pre-interaction
          log.info(
            `${selector}: Order on safe ${owner} not authed. Deleting order...`
          );
          return {
            result: PollResultCode.DONT_TRY_AGAIN,
            reason: `${selector}: The owner has not authorized the order`,
          };
        case "INTERFACE_NOT_SUPPORTED":
          log.info(
            `${selector}: Order on safe ${owner} attempted to use a handler that is not supported. Deleting order...`
          );
          return {
            result: PollResultCode.DONT_TRY_AGAIN,
            reason: `${selector}: The handler is not supported`,
          };
        case "INVALID_FALLBACK_HANDLER":
          log.info(
            `${selector}: Order for safe ${owner} where the Safe does not have ExtensibleFallbackHandler set. Deleting order...`
          );
          return {
            result: PollResultCode.DONT_TRY_AGAIN,
            reason: `${selector}: The safe does not have ExtensibleFallbackHandler set`,
          };
        case "SWAP_GUARD_RESTRICTED":
          log.info(
            `${selector}: Order for safe ${owner} where the Safe has swap guard enabled. Deleting order...`
          );
          return {
            result: PollResultCode.DONT_TRY_AGAIN,
            reason: `${selector}: The safe has swap guard enabled`,
          };
        // TODO: Add metrics to track this
        case "ORDER_NOT_VALID":
        case "POLL_TRY_NEXT_BLOCK":
          // OrderNotValid: With the revised custom errors, `OrderNotValid` is generally returned when elements
          // of the data struct are invalid. For example, if the `sellAmount` is zero, or the `validTo` is in
          // the past.
          // PollTryNextBlock: The conditional order has signalled that it should be polled again on the next block.
          log.info(
            `${selector}: Order on safe ${owner} not valid/signalled to try next block.`
          );
          return {
            result: PollResultCode.TRY_NEXT_BLOCK,
            reason: `${selector}: ${message}`,
          };
        case "POLL_TRY_AT_BLOCK":
          // The conditional order has signalled that it should be polled again on a specific block.
          if (!blockNumberOrEpoch) {
            throw new Error(
              `Expected blockNumberOrEpoch to be defined for ${selector}`
            );
          }
          return {
            result: PollResultCode.TRY_ON_BLOCK,
            blockNumber: blockNumberOrEpoch,
            reason: `PollTryAtBlock: ${message}`,
          };
        case "POLL_TRY_AT_EPOCH":
          // The conditional order has signalled that it should be polled again on a specific epoch.
          if (!blockNumberOrEpoch) {
            throw new Error(
              `Expected blockNumberOrEpoch to be defined for ${selector}`
            );
          }
          return {
            result: PollResultCode.TRY_AT_EPOCH,
            epoch: blockNumberOrEpoch,
            reason: `PollTryAtEpoch: ${message}`,
          };
        case "POLL_NEVER":
          // The conditional order has signalled that it should never be polled again.
          return {
            result: PollResultCode.DONT_TRY_AGAIN,
            reason: `PollNever: ${message}`,
          };
      }
    } catch (err: any) {
      log.error(`${logPrefix} Unexpected error`, err);
      return {
        result: PollResultCode.UNEXPECTED_ERROR,
        reason:
          "UnexpectedErrorName: Unexpected error" +
          (err.message ? `: ${err.message}` : ""),
        error: err,
      };
    }
  }

  log.error(`${logPrefix} ethers/call Unexpected error`, error);
  // If we don't know the reason, is better to not delete the order
  // TODO: Add metrics to track this
  return {
    result: PollResultCode.TRY_NEXT_BLOCK,
    reason:
      "UnexpectedErrorName: Unexpected error" +
      (error.message ? `: ${error.message}` : ""),
  };
}

/**
 * Convert an order kind hash to a string
 * @param kind of order in hash format
 * @returns string representation of the order kind
 */
export const kindToString = (kind: string) => {
  if (
    kind ===
    "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775"
  ) {
    return OrderKind.SELL;
  } else if (
    kind ===
    "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc"
  ) {
    return OrderKind.BUY;
  } else {
    throw new Error(`Unknown kind: ${kind}`);
  }
};

/**
 * Convert a balance source/destination hash to a string
 * @param balance balance source/destination hash
 * @returns string representation of the balance
 * @throws if the balance is not recognized
 */
export const balanceToString = (balance: string) => {
  if (
    balance ===
    "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9"
  ) {
    return OrderBalance.ERC20;
  } else if (
    balance ===
    "0xabee3b73373acd583a130924aad6dc38cfdc44ba0555ba94ce2ff63980ea0632"
  ) {
    return OrderBalance.EXTERNAL;
  } else if (
    balance ===
    "0x4ac99ace14ee0a5ef932dc609df0943ab7ac16b7583634612f8dc35a4289a6ce"
  ) {
    return OrderBalance.INTERNAL;
  } else {
    throw new Error(`Unknown balance type: ${balance}`);
  }
};
function getEmojiByPollResult(result?: PollResultCode) {
  if (!result) {
    return "";
  }

  switch (result) {
    case PollResultCode.SUCCESS:
      return "✅";

    case PollResultCode.DONT_TRY_AGAIN:
      return "✋";

    case PollResultCode.TRY_AT_EPOCH:
    case PollResultCode.TRY_ON_BLOCK:
      return "🕣";

    case PollResultCode.TRY_NEXT_BLOCK:
      return "👀";

    default:
      return "❌";
  }
}
