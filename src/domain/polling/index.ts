import {
  Order,
  OrderBalance,
  OrderKind,
  computeOrderUid,
} from "@cowprotocol/contracts";
import {
  OrderBookApi,
  OrderCreation,
  OrderPostError,
  SigningScheme,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import {
  ConditionalOrder as ConditionalOrderSDK,
  PollParams,
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  formatEpoch,
} from "@cowprotocol/sdk-composable";
import { ethers } from "ethers";
import { BytesLike } from "ethers/lib/utils";

import { ChainContext } from "../../services";
import { ConditionalOrder, OrderStatus } from "../../types";

import {
  LoggerWithMethods,
  formatStatus,
  getLogger,
  handleOnChainCustomError,
  metrics,
} from "../../utils";
import { badOrder, policy } from "./filtering";
import { pollConditionalOrder } from "./poll";

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

const HANDLED_RESULT_CODES = [
  PollResultCode.SUCCESS,
  PollResultCode.TRY_AT_EPOCH,
  PollResultCode.TRY_ON_BLOCK,
  PollResultCode.TRY_NEXT_BLOCK,
  PollResultCode.DONT_TRY_AGAIN,
];
const ApiErrors = OrderPostError.errorType;
type DropApiErrorsArray = Array<OrderPostError.errorType | string>;
type NextBlockApiErrorsArray = Array<OrderPostError.errorType>;
type BackOffApiErrorsDelays = {
  [K in OrderPostError.errorType | string]?: number;
};

/**
 * Handle error that will return `TRY_NEXT_BLOCK`, so it doesn't throw but is re-attempted on next block
 */
const API_ERRORS_TRY_NEXT_BLOCK: NextBlockApiErrorsArray = [
  ApiErrors.QUOTE_NOT_FOUND,
  ApiErrors.INVALID_QUOTE,
  ApiErrors.INSUFFICIENT_VALID_TO,
  ApiErrors.INVALID_EIP1271SIGNATURE, // May happen momentarily if the order is placed as a new block hits
];

const ONE_MIN = 60;
const TEN_MINS = 10 * 60;
const ONE_HOUR = 60 * 60;
const API_ERRORS_BACKOFF: BackOffApiErrorsDelays = {
  [ApiErrors.INSUFFICIENT_ALLOWANCE]: TEN_MINS,
  [ApiErrors.INSUFFICIENT_BALANCE]: TEN_MINS,
  [ApiErrors.TOO_MANY_LIMIT_ORDERS]: ONE_HOUR,
  [ApiErrors.INVALID_APP_DATA]: ONE_MIN, // Give the user some time to upload the correct appData
};

const API_ERRORS_DROP: DropApiErrorsArray = [
  ApiErrors.SELL_AMOUNT_OVERFLOW, // Implies a `feeAmount` has been set and `sellAmount` + `feeAmount` > `type(uint256).max`
  ApiErrors.TRANSFER_SIMULATION_FAILED, // Sell token can't be transferred, drop it
  ApiErrors.ZERO_AMOUNT, // Any order with zero amount indicates bad logic, drop it
  ApiErrors.UNSUPPORTED_BUY_TOKEN_DESTINATION,
  ApiErrors.TOO_MUCH_GAS, // Order is too large, likely some bad logic, drop it
  ApiErrors.UNSUPPORTED_SELL_TOKEN_SOURCE,
  ApiErrors.UNSUPPORTED_ORDER_TYPE,
  ApiErrors.EXCESSIVE_VALID_TO, // Order is too far in the future, likely some bad logic, drop it
  ApiErrors.INVALID_NATIVE_SELL_TOKEN,
  ApiErrors.SAME_BUY_AND_SELL_TOKEN,
  ApiErrors.UNSUPPORTED_TOKEN,
  ApiErrors.APPDATA_FROM_MISMATCH, // AppData doesn't have the expected `from` value, drop it
];

// Impossible to reach API errors:
// ApiErrors.MissingFrom - we control this in the watch-tower and is set when the order is created
// ApiErrors.WrongOwner - this is always the from as it's an EIP-1271 signature
// ApiErrors.InvalidSignature - only for EOA signatures and we don't use them
// ApiErrors.IncompatibleSigningScheme - we control this in the watch-tower
// ApiErrors.AppDataHashMismatch - we never submit full appData

const CHUNK_SIZE = 50; // How many orders to process before saving

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
  const { ownerOrders, numOrders, numOwners } = registry;

  const blockNumber = blockNumberOverride || block.number;
  const blockTimestamp = blockTimestampOverride || block.timestamp;

  let hasErrors = false;
  let ownerCounter = 0;
  let orderCounter = 0;
  let updatedCount = 0;

  const loggerParams = {
    name: "checkForAndPlaceOrder",
    chainId,
    blockNumber,
  };
  const log = getLogger(loggerParams);
  log.debug(`The registry has ${numOwners} owners and ${numOrders} orders`);

  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCounter++;
    const log = getLogger({
      ...loggerParams,
      ownerNumber: ownerCounter,
    });

    let ordersPendingDelete = [];

    log.debug(
      `Process owner ${ownerCounter}/${numOwners}. Owner=${owner}. Orders=${conditionalOrders.size}`
    );

    for (const conditionalOrder of conditionalOrders) {
      orderCounter++;

      const log = getLogger({
        ...loggerParams,
        blockNumber,
        ownerNumber: ownerCounter,
        orderNumber: orderCounter,
      });

      // Check if we reached the chunk size
      if (updatedCount % CHUNK_SIZE === 1 && updatedCount > 1) {
        // Delete orders pending delete, if any
        deleteOrders(ordersPendingDelete, conditionalOrders, log, chainId);
        // Reset tracker
        ordersPendingDelete = [];

        log.debug(`Processed ${updatedCount}, saving registry`);

        // Save the registry after processing each chunk
        await registry.write();
      }

      const logOrderDetails = `Processing order ${orderCounter}/${numOrders} with ID ${conditionalOrder.id} from TX ${conditionalOrder.tx} with params:`;

      const { result: lastHint } = conditionalOrder.pollResult || {};

      // Apply filtering policy
      if (filterPolicy) {
        const filterResult = filterPolicy.preFilter({
          conditionalOrderId: conditionalOrder.id,
          transaction: conditionalOrder.tx,
          owner,
          conditionalOrderParams: conditionalOrder.params,
        });

        switch (filterResult) {
          case policy.FilterAction.DROP:
            log.info("Dropping conditional order. Reason: AcceptPolicy: DROP");
            ordersPendingDelete.push(conditionalOrder);
            continue;
          case policy.FilterAction.SKIP:
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

      const pollResult = await processConditionalOrder(
        owner,
        conditionalOrder,
        blockTimestamp,
        blockNumber,
        context,
        ownerCounter,
        orderCounter
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
      // Order needs saving!
      updatedCount++;

      // Log the result
      const unexpectedError =
        pollResult?.result === PollResultCode.UNEXPECTED_ERROR;

      // Print the polling result
      const isError = pollResult.result !== PollResultCode.SUCCESS;
      const resultDescription =
        pollResult.result +
        (isError && pollResult.reason ? `. Reason: ${pollResult.reason}` : "");

      log[unexpectedError ? "error" : "info"](
        `Check conditional order result for order ${
          conditionalOrder.id
        }: ${getEmojiByPollResult(pollResult?.result)} ${resultDescription}`
      );
      if (unexpectedError) {
        log.error(
          `UNEXPECTED_ERROR for order ${conditionalOrder.id}. Details:`,
          pollResult.error
        );
      }

      hasErrors ||= unexpectedError;
    }

    // Delete orders we don't want to keep watching
    deleteOrders(ordersPendingDelete, conditionalOrders, log, chainId);
  }

  // It may be handy in other versions of the watch tower implemented in other languages
  // to not delete owners, so we can keep track of them.
  for (const [owner, conditionalOrders] of ownerOrders) {
    if (conditionalOrders.size === 0) {
      ownerOrders.delete(owner);
      metrics.activeOwnersTotal.labels(chainId.toString()).dec();
    }
  }

  // save the registry - don't catch errors here, as it's now a docker container
  // and we want to crash if there's an error
  await registry.write();

  log.debug(
    `After processing orders. Owners=${registry.numOwners}, Orders=${registry.numOrders}`
  );

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(`At least one unexpected error processing conditional orders`);
  }
}

function deleteOrders(
  ordersPendingDelete: ConditionalOrder[],
  conditionalOrders: Set<ConditionalOrder>,
  log: LoggerWithMethods,
  chainId: SupportedChainId
) {
  ordersPendingDelete.length &&
    log.debug(
      `Delete ${ordersPendingDelete.length} orders: ${ordersPendingDelete.join(
        ", "
      )}`
    );

  for (const conditionalOrder of ordersPendingDelete) {
    const deleted = conditionalOrders.delete(conditionalOrder);
    const action = deleted ? "Stop Watching" : "Failed to stop watching";

    log.debug(
      `${action} conditional order ${conditionalOrder.id} from TX ${conditionalOrder.tx}`
    );
    metrics.activeOrdersTotal.labels(chainId.toString()).dec();
  }
}

async function processConditionalOrder(
  owner: string,
  conditionalOrder: ConditionalOrder,
  blockTimestamp: number,
  blockNumber: number,
  context: ChainContext,
  ownerNumber: number,
  orderNumber: number
): Promise<PollResult> {
  const { provider, orderBookApi, dryRun, chainId } = context;
  const { handler } = conditionalOrder.params;

  const log = getLogger({
    name: "processConditionalOrder",
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  });
  const metricLabels = [
    chainId.toString(),
    handler,
    owner,
    conditionalOrder.id,
  ];
  try {
    metrics.pollingRunsTotal.labels(...metricLabels).inc();

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
      orderBookApi,
    };

    let pollResult = await pollConditionalOrder(
      conditionalOrder.id,
      pollParams,
      conditionalOrder.params,
      chainId,
      blockNumber,
      ownerNumber,
      orderNumber
    );

    if (!pollResult) {
      // Unsupported Order Type (unknown handler)
      // For now, fallback to legacy behavior
      // TODO: Decide in the future what to do. Probably, move the error handling to the SDK and kill the poll Legacy
      pollResult = await metrics.measureTime({
        action: () =>
          pollLegacy(
            context,
            owner,
            conditionalOrder,
            proof,
            offchainInput,
            blockNumber,
            ownerNumber,
            orderNumber
          ),
        labelValues: metricLabels,
        durationMetric: metrics.pollingOnChainDurationSeconds,
        totalRunsMetric: metrics.pollingOnChainChecksTotal,
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
      appData: order.appData as string,
      kind: kindToString(order.kind as string),
      sellTokenBalance: balanceToString(order.sellTokenBalance as string),
      buyTokenBalance: balanceToString(order.buyTokenBalance as string),
      validTo: Number(order.validTo),
    };

    // We now have the order, so we can validate it. This will throw if the order is invalid
    // and we will catch it below.
    try {
      badOrder.check(orderToSubmit);
    } catch (e: any) {
      return {
        result: PollResultCode.DONT_TRY_AGAIN,
        reason: `Invalid order: ${e.message}`,
      };
    }

    // calculate the orderUid
    const orderUid = getOrderUid(chainId, orderToSubmit, owner);

    // Place order, if the orderUid has not been submitted or filled
    if (!conditionalOrder.orders.has(orderUid)) {
      // Place order
      const placeOrderResult = await postDiscreteOrder({
        conditionalOrder,
        orderUid,
        order: { ...orderToSubmit, from: owner, signature },
        orderBookApi,
        blockTimestamp,
        dryRun,
        metricLabels,
        chainId,
        blockNumber,
        ownerNumber,
        orderNumber,
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
    metrics.pollingUnexpectedErrorsTotal.labels(...metricLabels).inc();
    return {
      result: PollResultCode.UNEXPECTED_ERROR,
      error: e,
      reason:
        "Unhandled error processing conditional order" +
        (e.message ? `: ${e.message}` : ""),
    };
  }
}

function getOrderUid(
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
async function postDiscreteOrder(params: {
  conditionalOrder: ConditionalOrder;
  orderUid: string;
  order: any;
  orderBookApi: OrderBookApi;
  blockTimestamp: number;
  dryRun: boolean;
  metricLabels: string[];
  chainId: SupportedChainId;
  blockNumber: number;
  ownerNumber: number;
  orderNumber: number;
}): Promise<Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors> {
  const {
    conditionalOrder,
    orderUid,
    order,
    orderBookApi,
    blockTimestamp,
    dryRun,
    metricLabels,
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  } = params;
  const log = getLogger({
    name: "postDiscreteOrder",
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  });

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
    log.info(
      `Post order ${orderUid} (ID=${conditionalOrder.id}, TX=${conditionalOrder.tx})`
    );
    log.debug(`Post order ${orderUid} details`, postOrder);
    if (!dryRun) {
      const orderUid = await orderBookApi.sendOrder(postOrder);
      metrics.orderBookDiscreteOrdersTotal.labels(...metricLabels).inc();
      log.info(`API response`, { orderUid });
    }
  } catch (error: any) {
    let reasonError = "Error placing order in API";
    if (error.response) {
      const { status } = error.response;
      const { body } = error;

      const handleErrorResult = handleOrderBookError(
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

function handleOrderBookError(
  status: any,
  body: any,
  error: any,
  blockTimestamp: number,
  metricLabels: string[]
): Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors {
  const apiError = body?.errorType as OrderPostError.errorType;
  metrics.orderBookErrorsTotal
    .labels(...metricLabels, status.toString(), apiError)
    .inc();
  switch (status) {
    case 400:
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
          )} minutes, at ${nextPollTimestamp} ${formatEpoch(
            nextPollTimestamp
          )}`,
        };
      }

      // Handle some errors, that might be solved in the next block
      if (API_ERRORS_TRY_NEXT_BLOCK.includes(apiError)) {
        return {
          result: PollResultCode.TRY_NEXT_BLOCK,
          reason: `OrderBook API Known Error: ${apiError}, ${body?.description}`,
        };
      }

      // Drop orders that have some element of invalidity
      if (API_ERRORS_DROP.includes(apiError)) {
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `OrderBook API Known Error: ${apiError}, ${body?.description}`,
        };
      }

      break;
    case 403:
      // The account has been explicitly deny listed by the API, drop the order
      return {
        result: PollResultCode.DONT_TRY_AGAIN,
        reason: `Account has been explicitly deny listed`,
      };
    case 404:
      // No liquidity found when quoting the order - may turn up again at some stage
      const nextPollTimestamp = blockTimestamp + TEN_MINS;
      return {
        result: PollResultCode.TRY_AT_EPOCH,
        epoch: nextPollTimestamp,
        reason: `No liquidity found when quoting order. Scheduling next polling in ${Math.floor(
          TEN_MINS / 60
        )} minutes, at ${nextPollTimestamp} ${formatEpoch(nextPollTimestamp)}`,
      };
    case 429:
      // Too many orders placed, back off for a while
      const nextPollTimestamp429 = blockTimestamp + TEN_MINS;
      return {
        result: PollResultCode.TRY_AT_EPOCH,
        epoch: nextPollTimestamp429,
        reason: `Too many orders placed. Scheduling next polling in ${Math.floor(
          TEN_MINS / 60
        )} minutes, at ${nextPollTimestamp429} ${formatEpoch(
          nextPollTimestamp429
        )}`,
      };
  }

  return {
    result: PollResultCode.UNEXPECTED_ERROR,
    reason: `OrderBook API Unknown Error: ${apiError}, ${body?.description}`,
    error,
  };
}

async function pollLegacy(
  context: ChainContext,
  owner: string,
  conditionalOrder: ConditionalOrder,
  proof: string[],
  offchainInput: string,
  blockNumber: number,
  ownerNumber: number,
  orderNumber: number
): Promise<PollResult> {
  const { contract, multicall, chainId } = context;
  const log = getLogger({
    name: "pollLegacy",
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  });
  const { composableCow: target } = conditionalOrder;
  const { handler } = conditionalOrder.params;
  // as we going to use multicall, with `aggregate3Value`, there is no need to do any simulation as the
  // calls are guaranteed to pass, and will return the results, or the reversion within the ABI-encoded data.
  // By not using `populateTransaction`, we avoid an `eth_estimateGas` RPC call.
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
      try {
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
      } catch (error: any) {
        log.error(`ethers/decodeFunctionResult Unexpected error`, error);
        metrics.pollingOnChainEthersErrorsTotal.labels(...metricLabels).inc();
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason:
            "UnexpectedErrorName: Data decoding failure" +
            (error.message ? `: ${error.message}` : ""),
        };
      }
    }

    // If the low-level call failed, per the `ComposableCoW` interface, the contract is attempting to
    // provide hints to the watch-tower. But, we can't trust all the data returned as there may be
    // order types created that are _not_ adhering to the interface (and are therefore invalid).
    return handleOnChainCustomError({
      owner,
      chainId,
      target,
      callData,
      revertData: returnData,
      metricLabels,
      blockNumber,
      ownerNumber,
      orderNumber,
    });
  } catch (error: any) {
    // We can only get here from some provider / ethers failure. As the contract hasn't had it's say
    // we will defer to try again.
    log.error(`ethers/call Unexpected error`, error);
    metrics.pollingOnChainEthersErrorsTotal.labels(...metricLabels).inc();
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
