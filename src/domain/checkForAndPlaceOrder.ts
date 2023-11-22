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
  formatStatus,
  getLogger,
  pollConditionalOrder,
  handleOnChainCustomError,
} from "../utils";
import {
  ConditionalOrder as ConditionalOrderSDK,
  OrderBookApi,
  OrderCreation,
  OrderPostError,
  PollParams,
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  SigningScheme,
  SupportedChainId,
  formatEpoch,
} from "@cowprotocol/cow-sdk";
import { ChainContext, SDK_BACKOFF_NUM_OF_ATTEMPTS } from "./chainContext";
import {
  pollingOnChainDurationSeconds,
  activeOrdersTotal,
  activeOwnersTotal,
  orderBookDiscreteOrdersTotal,
  orderBookErrorsTotal,
  pollingOnChainChecksTotal,
  pollingRunsTotal,
  pollingUnexpectedErrorsTotal,
  pollingOnChainEthersErrorsTotal,
  measureTime,
} from "../utils/metrics";
import { FilterAction } from "../utils/filterPolicy";

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

const HANDLED_RESULT_CODES = [
  PollResultCode.SUCCESS,
  PollResultCode.TRY_AT_EPOCH,
  PollResultCode.TRY_ON_BLOCK,
  PollResultCode.TRY_NEXT_BLOCK,
  PollResultCode.DONT_TRY_AGAIN,
];

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
 * @param context chain context
 * @param event block event
 */
export async function checkForAndPlaceOrder(
  context: ChainContext,
  block: ethers.providers.Block,
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { chainId, registry, filterPolicy } = context;
  const { ownerOrders, numOrders } = registry;

  const blockNumber = blockNumberOverride || block.number;
  const blockTimestamp = blockTimestampOverride || block.timestamp;

  let hasErrors = false;
  let ownerCounter = 0;
  let orderCounter = 0;

  const log = getLogger(
    "checkForAndPlaceOrder:checkForAndPlaceOrder",
    chainId.toString(),
    blockNumber.toString()
  );
  log.debug(`Total number of orders: ${numOrders}`);

  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCounter++;
    const log = getLogger(
      "checkForAndPlaceOrder:checkForAndPlaceOrder",
      chainId.toString(),
      blockNumber.toString(),
      ownerCounter.toString()
    );
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    log.debug(`Process owner ${owner} (${conditionalOrders.size} orders)`);
    for (const conditionalOrder of conditionalOrders) {
      orderCounter++;
      const ownerRef = `${ownerCounter}.${orderCounter}`;
      const orderRef = `${chainId}:${ownerRef}@${blockNumber}`;
      const log = getLogger(
        "checkForAndPlaceOrder:checkForAndPlaceOrder",
        chainId.toString(),
        blockNumber.toString(),
        ownerRef
      );
      const logOrderDetails = `Processing order from TX ${conditionalOrder.tx} with params:`;

      const { result: lastHint } = conditionalOrder.pollResult || {};

      // Apply filtering policy
      if (filterPolicy) {
        const filterResult = filterPolicy.preFilter({
          owner,
          conditionalOrderParams: conditionalOrder.params,
        });

        switch (filterResult) {
          case FilterAction.DROP:
            log.debug("Dropping conditional order. Reason: AcceptPolicy: DROP");
            ordersPendingDelete.push(conditionalOrder);

            continue;
          case FilterAction.SKIP:
            log.debug("Skipping conditional order. Reason: AcceptPolicy: SKIP");
            continue;
        }
      }

      // Check if the order is due (by epoch)
      if (
        lastHint?.result === PollResultCode.TRY_AT_EPOCH &&
        blockTimestamp < lastHint.epoch
      ) {
        log.debug(
          `Skipping conditional order. Reason: Not due yet (TRY_AT_EPOCH=${
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
          `Skipping conditional order. Reason: Not due yet (TRY_ON_BLOCK=${
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
      activeOrdersTotal.labels(chainId.toString()).dec();
    }
  }

  // It may be handy in other versions of the watch tower implemented in other languages
  // to not delete owners, so we can keep track of them.
  for (const [owner, conditionalOrders] of Array.from(ownerOrders.entries())) {
    if (conditionalOrders.size === 0) {
      ownerOrders.delete(owner);
      activeOwnersTotal.labels(chainId.toString()).dec();
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
  const { provider, orderBook, dryRun, chainId, orderBookApiBaseUrls } =
    context;
  const { handler } = conditionalOrder.params;
  const log = getLogger(
    "checkForAndPlaceOrder:_processConditionalOrder",
    orderRef
  );
  const id = ConditionalOrderSDK.leafToId(conditionalOrder.params);
  const metricLabels = [chainId.toString(), handler, owner, id];
  try {
    pollingRunsTotal.labels(...metricLabels).inc();

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
      // TODO: This should be DRY'ed. Upstream should take just an `orderBook` object that
      //       is already configured.
      orderbookApiConfig: {
        baseUrls: orderBookApiBaseUrls,
        backoffOpts: {
          numOfAttempts: SDK_BACKOFF_NUM_OF_ATTEMPTS,
        },
      },
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
      pollResult = await measureTime({
        action: () =>
          _pollLegacy(
            context,
            owner,
            conditionalOrder,
            proof,
            offchainInput,
            orderRef
          ),
        labelValues: metricLabels,
        durationMetric: pollingOnChainDurationSeconds,
        totalRunsMetric: pollingOnChainChecksTotal,
      });
    }

    // This should be impossible to reach, but satisfies the compiler
    if (pollResult === undefined) {
      throw new Error("Unexpected error: pollResult is undefined");
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
        metricLabels,
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
    pollingUnexpectedErrorsTotal.labels(...metricLabels).inc();
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
  metricLabels: string[];
}): Promise<Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors> {
  const {
    orderUid,
    order,
    orderBook,
    orderRef,
    blockTimestamp,
    dryRun,
    metricLabels,
  } = params;
  const log = getLogger("checkForAndPlaceOrder:_placeOrder", orderRef);
  const { chainId } = orderBook.context;
  try {
    const postOrder: OrderCreation = {
      kind: order.kind,
      from: order.from,
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      receiver: order.receiver,
      feeAmount: order.feeAmount.toString(),
      validTo: order.validTo,
      appData: order.appData,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: order.sellTokenBalance,
      buyTokenBalance: order.buyTokenBalance,
      signingScheme: SigningScheme.EIP1271,
      signature: order.signature,
    };

    // If the operation is a dry run, don't post to the API
    log.info(`Post order ${orderUid} to OrderBook on chain ${chainId}`);
    log.debug(`Post order details`, postOrder);
    if (!dryRun) {
      const orderUid = await orderBook.sendOrder(postOrder);
      orderBookDiscreteOrdersTotal.labels(...metricLabels).inc();
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
        blockTimestamp,
        metricLabels
      );
      const isHandled = HANDLED_RESULT_CODES.includes(handleErrorResult.result);
      const logLevel = isHandled ? "info" : "error";
      log[logLevel](
        `${
          isHandled ? "Unable to place" : "Error placing"
        } order in API. Result: ${status}`,
        body
      );

      return handleErrorResult;
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
  blockTimestamp: number,
  metricLabels: string[]
): Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors {
  const apiError = body?.errorType as OrderPostError.errorType;
  orderBookErrorsTotal
    .labels(...metricLabels, status.toString(), apiError)
    .inc();
  if (status === 400) {
    // The order is in the OrderBook, all good :)
    if (apiError === ApiErrors.DUPLICATED_ORDER) {
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
  const { contract, multicall, chainId } = context;
  const log = getLogger("checkForAndPlaceOrder:_pollLegacy", orderRef);
  const { handler } = conditionalOrder.params;
  // as we going to use multicall, with `aggregate3Value`, there is no need to do any simulation as the
  // calls are guaranteed to pass, and will return the results, or the reversion within the ABI-encoded data.
  // By not using `populateTransaction`, we avoid an `eth_estimateGas` RPC call.
  const target = contract.address;
  const callData = contract.interface.encodeFunctionData(
    "getTradeableOrderWithSignature",
    [owner, conditionalOrder.params, offchainInput, proof]
  );
  const id = ConditionalOrderSDK.leafToId(conditionalOrder.params);
  const metricLabels = [chainId.toString(), owner, handler, id];

  try {
    const lowLevelCall = await multicall.callStatic.aggregate3Value([
      {
        target,
        allowFailure: true,
        value: 0,
        callData,
      },
    ]);

    const [{ success, returnData }] = lowLevelCall;

    if (success) {
      // Decode the returnData to get the order and signature tuple
      const { order, signature } = contract.interface.decodeFunctionResult(
        "getTradeableOrderWithSignature",
        returnData
      );
      return {
        result: PollResultCode.SUCCESS,
        order,
        signature,
      };
    }

    // If the low-level call failed, per the `ComposableCoW` interface, the contract is attempting to
    // provide hints to the watch-tower. But, we can't trust all the data returned as there may be
    // order types created that are _not_ adhering to the interface (and are therefore invalid).
    return handleOnChainCustomError({
      owner,
      orderRef,
      chainId,
      target,
      callData,
      revertData: returnData,
      metricLabels,
    });
  } catch (error: any) {
    // We can only get here from some provider / ethers failure. As the contract hasn't had it's say
    // we will defer to try again.
    log.error(`ethers/call Unexpected error`, error);
    pollingOnChainEthersErrorsTotal.labels(...metricLabels).inc();
    return {
      result: PollResultCode.TRY_NEXT_BLOCK,
      reason:
        "UnexpectedErrorName: Unexpected error" +
        (error.message ? `: ${error.message}` : ""),
    };
  }
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
