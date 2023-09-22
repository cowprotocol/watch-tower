import { ActionFn, BlockEvent, Context, Event } from "@tenderly/actions";
import {
  Order,
  OrderBalance,
  OrderKind,
  computeOrderUid,
} from "@cowprotocol/contracts";

import axios from "axios";

import { ethers } from "ethers";
import { BytesLike, Logger } from "ethers/lib/utils";

import {
  ComposableCoW,
  ComposableCoW__factory,
  Multicall3,
  Multicall3__factory,
} from "./types";
import {
  LowLevelError,
  ORDER_NOT_VALID_SELECTOR,
  PROOF_NOT_AUTHED_SELECTOR,
  SINGLE_ORDER_NOT_AUTHED_SELECTOR,
  formatStatus,
  handleExecutionError,
  initContext,
  parseCustomError,
  toChainId,
  writeRegistry,
} from "./utils";
import {
  ChainContext,
  ConditionalOrder,
  OrderStatus,
  OrderUid,
  PendingOrderShadowMode,
} from "./model";
import { pollConditionalOrder } from "./utils/poll";
import {
  OrderPostError,
  PollParams,
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  SupportedChainId,
  formatEpoch,
} from "@cowprotocol/cow-sdk";

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Handle error that will return `TRY_NEXT_BLOCK`, so it doesn't throw but is re-attempted on next block
 */
const ORDER_BOOK_API_HANDLED_ERRORS = [
  "InsufficientBalance",
  "InsufficientAllowance",
  "InsufficientFee",
];

const ApiErrors = OrderPostError.errorType;
const WAITING_TIME_SECONDS_FOR_NOT_BALANCE = 10 * 60; // 10 min

/**
 * Shadow mode will lag 2 minutes behind
 */
const SHADOW_MODE_LAG_SECONDS = 2 * 60; // 2 min

/**
 * Watch for new blocks and check for orders to place
 *
 * @param context tenderly context
 * @param event block event
 */
export const checkForAndPlaceOrder: ActionFn = async (
  context: Context,
  event: Event
) => {
  return _checkForAndPlaceOrder(context, event).catch(handleExecutionError);
};

/**
 * Asyncronous version of checkForAndPlaceOrder. It will process all the orders, and will throw an error at the end if there was at least one error
 */
const _checkForAndPlaceOrder: ActionFn = async (
  context: Context,
  event: Event
) => {
  const blockEvent = event as BlockEvent;
  const { network, blockNumber } = blockEvent;
  const chainId = toChainId(network);
  const chainContext = await ChainContext.create(context, chainId);
  const { registry, isShadowMode } = await initContext(
    "checkForAndPlaceOrder",
    chainId,
    context
  );
  const logPrefixMain = `[checkForAndPlaceOrder@${blockNumber}]`;
  const { ownerOrders, pendingOrdersShadowMode } = registry;

  let hasErrors = false;
  let ownerCounter = 0;
  let orderCounter = 0;

  const { timestamp: blockTimestamp } = await chainContext.provider.getBlock(
    blockNumber
  );

  // In shadow mode, we check all pending orders
  if (isShadowMode && pendingOrdersShadowMode.size > 0) {
    const logPrefix = `[shadowCheck@${blockNumber}]`;
    for (const [orderUid, pendingOrderShadowMode] of Array.from(
      pendingOrdersShadowMode.entries()
    )) {
      const { conditionalOrder, conditionalOrderId, order } =
        pendingOrderShadowMode;
      _handleOrderShadowMode({
        orderUid: orderUid.toString(),
        conditionalOrderId,
        conditionalOrder,
        blockTimestamp,
        apiUrl: chainContext.apiUrl,
        pendingOrdersShadowMode,
        orderToPost: order,
        logPrefix,
      }).catch((e) => {
        // Don't let the pending shadow orders to stop the execution
        console.error(`${logPrefix} Error handling the order ${orderUid}`, e);
      });
    }
    console.log(
      `${logPrefixMain} Shadow mode. Processing ${pendingOrdersShadowMode.size} pending orders`
    );
  }

  console.log(`${logPrefixMain} Number of orders: `, registry.numOrders);

  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCounter++;
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    console.log(
      `[checkForAndPlaceOrder::${ownerCounter}@${blockNumber}] Process owner ${owner} (${conditionalOrders.size} orders)`
    );
    for (const conditionalOrder of conditionalOrders) {
      orderCounter++;
      const orderRef = `${ownerCounter}.${orderCounter}@${blockNumber}`;
      const logPrefix = `[checkForAndPlaceOrder::${orderRef}]`;
      const logOrderDetails = `Processing order from TX ${conditionalOrder.tx} with params:`;

      const { result: lastResult } = conditionalOrder.pollResult || {};

      // Check if the order is due (by epoch)
      if (
        lastResult?.result === PollResultCode.TRY_AT_EPOCH &&
        blockTimestamp < lastResult.epoch
      ) {
        console.log(
          `${logPrefix} Skipping conditional. Reason: Not due yet (TRY_AT_EPOCH=${
            lastResult.epoch
          }, ${formatEpoch(lastResult.epoch)}). ${logOrderDetails}`,
          conditionalOrder.params
        );
        continue;
      }

      // Check if the order is due (by blockNumber)
      if (
        lastResult?.result === PollResultCode.TRY_ON_BLOCK &&
        blockNumber < lastResult.blockNumber
      ) {
        console.log(
          `${logPrefix} Skipping conditional. Reason: Not due yet (TRY_ON_BLOCK=${
            lastResult.blockNumber
          }, in ${
            lastResult.blockNumber - blockNumber
          } blocks). ${logOrderDetails}`,
          conditionalOrder.params
        );
        continue;
      }

      // Proceed with the normal check
      console.log(`${logPrefix} ${logOrderDetails}`, conditionalOrder.params);
      const contract = ComposableCoW__factory.connect(
        conditionalOrder.composableCow,
        chainContext.provider
      );
      const multicall = Multicall3__factory.connect(
        MULTICALL3,
        chainContext.provider
      );

      const pollResult = await _processConditionalOrder(
        owner,
        chainId,
        conditionalOrder,
        blockTimestamp,
        blockNumber,
        contract,
        multicall,
        chainContext,
        orderRef,
        isShadowMode,
        pendingOrdersShadowMode
      );

      // Don't try again the same order, in case thats the poll result
      if (pollResult.result === PollResultCode.DONT_TRY_AGAIN) {
        // Check if the TX exists. This avoids one race condition where the order has been registered but our RPC don't see it yet.
        // It can happen if:
        //    - Tenderly RPC node is ahead of our RPC node
        //    - There's a reorg between the registration and the polling
        const transactionExists = await chainContext.provider
          .getTransaction(conditionalOrder.tx)
          .then(() => true)
          .catch(() => false);

        if (transactionExists) {
          ordersPendingDelete.push(conditionalOrder);
        }
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

      const logLevel =
        pollResult.result === PollResultCode.SUCCESS
          ? "log"
          : pollResult.result === PollResultCode.UNEXPECTED_ERROR
          ? "error"
          : "warn";

      console[logLevel](
        `${logPrefix} Check conditional order result: ${getEmojiByPollResult(
          pollResult?.result
        )} ${resultDescription}`
      );
      if (unexpectedError) {
        console.error(
          `${logPrefix} UNEXPECTED_ERROR Details:`,
          pollResult.error
        );
      }

      hasErrors ||= unexpectedError;
    }

    // Delete orders we don't want to keep watching
    for (const conditionalOrder of ordersPendingDelete) {
      const deleted = conditionalOrders.delete(conditionalOrder);
      const action = deleted ? "Deleted" : "Fail to delete";
      console.log(
        `${logPrefixMain} ${action} conditional order with params:`,
        conditionalOrder.params
      );
    }
  }

  // It may be handy in other versions of the watch tower implemented in other languages
  // (ie. not for Tenderly) to not delete owners, so we can keep track of them.
  for (const [owner, conditionalOrders] of Array.from(ownerOrders.entries())) {
    if (conditionalOrders.size === 0) {
      ownerOrders.delete(owner);
    }
  }

  // Update the registry
  hasErrors ||= await !writeRegistry();

  // console.log(
  //   `[run_local] New CONDITIONAL_ORDER_REGISTRY value: `,
  //   registry.stringifyOrders()
  // );

  console.log(`${logPrefixMain} Remaining orders: `, registry.numOrders);

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(
      `${logPrefixMain} At least one unexpected error processing conditional orders`
    );
  }
};

async function _processConditionalOrder(
  owner: string,
  chainId: SupportedChainId,
  conditionalOrder: ConditionalOrder,
  blockTimestamp: number,
  blockNumber: number,
  contract: ComposableCoW,
  multicall: Multicall3,
  chainContext: ChainContext,
  orderRef: string,
  isShadowMode: boolean,
  pendingOrdersShadowMode: Map<OrderUid, PendingOrderShadowMode>
): Promise<PollResult> {
  try {
    const logPrefix = `[processConditionalOrder::${orderRef}]`;
    // TODO: Fix model and delete the explicit cast: https://github.com/cowprotocol/tenderly-watch-tower/issues/18
    const [handler, salt, staticInput] = conditionalOrder.params as any as [
      string,
      string,
      string
    ];

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
      provider: chainContext.provider,
    };
    const conditionalOrderParams = {
      handler,
      staticInput,
      salt,
    };
    const result = await pollConditionalOrder(
      pollParams,
      conditionalOrderParams,
      orderRef
    );
    const { pollResult, conditionalOrderId } = result
      ? result
      : {
          // Unsupported Order Type (unknown handler)
          // For now, fallback to legacy behavior
          // TODO: Decide in the future what to do. Probably, move the error handling to the SDK and kill the poll Legacy
          conditionalOrderId: undefined,
          pollResult: await _pollLegacy(
            owner,
            chainId,
            conditionalOrder,
            contract,
            multicall,
            proof,
            offchainInput,
            orderRef
          ),
        };

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
    const orderToPost = toOrderApi(orderToSubmit, owner, signature);

    if (isShadowMode) {
      // In case we run in shadow mode, we decide if we post the order or not
      const shadowModeResult = await _handleOrderShadowMode({
        orderUid,
        conditionalOrderId,
        conditionalOrder,
        blockTimestamp,
        pendingOrdersShadowMode,
        orderToPost,
        logPrefix,
        apiUrl: chainContext.apiUrl,
      });

      // If the order shouldn't be posted, we return early
      if (shadowModeResult) {
        return shadowModeResult;
      }
    }

    // Place order, if the orderUid has not been submitted or filled
    if (!conditionalOrder.orders.has(orderUid)) {
      // Place order
      const placeOrderResult = await _placeOrder({
        orderUid,
        order: orderToPost,
        apiUrl: chainContext.apiUrl,
        blockTimestamp,
        orderRef,
      });

      // In case of error, return early
      if (placeOrderResult.result !== PollResultCode.SUCCESS) {
        return placeOrderResult;
      }

      // Mark order as submitted
      conditionalOrder.orders.set(orderUid, OrderStatus.SUBMITTED);

      // If shadow mode, delete the order from the pending orders
      if (isShadowMode) {
        pendingOrdersShadowMode.delete(orderUid);
      }
    } else {
      const orderStatus = conditionalOrder.orders.get(orderUid);
      console.log(
        `${logPrefix} OrderUid ${orderUid} status: ${
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
  apiUrl: string;
  orderRef: string;
  blockTimestamp: number;
}): Promise<Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors> {
  const { orderUid, order, apiUrl, orderRef, blockTimestamp } = params;

  const logPrefix = `[placeOrder::${orderRef}]`;
  try {
    // if the apiUrl doesn't contain localhost, post
    console.log(`${logPrefix} Post order ${orderUid} to ${apiUrl}`);
    console.log(`${logPrefix} Order`, order);
    if (!apiUrl.includes("localhost")) {
      const { status, data } = await axios.post(
        `${apiUrl}/api/v1/orders`,
        order,
        {
          headers: {
            "Content-Type": "application/json",
            accept: "application/json",
          },
        }
      );
      console.log(`${logPrefix} API response`, { status, data });
    }
  } catch (error: any) {
    let reasonError = "Error placing order in API";
    if (error.response) {
      const { status, data } = error.response;

      const handleErrorResult = _handleOrderBookError({
        status,
        data,
        error,
        blockTimestamp,
      });
      const isSuccess = handleErrorResult.result === PollResultCode.SUCCESS;

      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      const log = console[isSuccess ? "warn" : "error"];
      log(`${logPrefix} Error placing order in API. Result: ${status}`, data);

      if (isSuccess) {
        log(`${orderRef} All good! continuing with warnings...`);
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

function _handleOrderBookError(params: {
  status: any;
  data: any;
  error: any;
  blockTimestamp: number;
}): Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors {
  const { status, data, error, blockTimestamp } = params;
  if (status === 400) {
    // The order is in the OrderBook, all good :)
    if (data?.errorType === ApiErrors.DUPLICATE_ORDER) {
      return {
        result: PollResultCode.SUCCESS,
      };
    }

    // It's possible that an order has not enough allowance or balance.
    // Returning DONT_TRY_AGAIN would be to drastic, but we can give the WatchTower a break by scheduling next attempt in a few minutes
    // This why, we don't so it doesn't try in every block
    if (
      [
        ApiErrors.INSUFFICIENT_ALLOWANCE,
        ApiErrors.INSUFFICIENT_BALANCE,
      ].includes(data?.errorType)
    ) {
      const nextPollTimestamp =
        blockTimestamp + WAITING_TIME_SECONDS_FOR_NOT_BALANCE;
      return {
        result: PollResultCode.TRY_AT_EPOCH,
        epoch: nextPollTimestamp,
        reason: `Not enough allowance/balance (${
          data?.errorType
        }). Scheduling next polling in ${Math.floor(
          WAITING_TIME_SECONDS_FOR_NOT_BALANCE / 60
        )} minutes, at ${nextPollTimestamp} ${formatEpoch(nextPollTimestamp)}`,
      };
    }

    // Handle some errors, that might be solved in the next block
    if (ORDER_BOOK_API_HANDLED_ERRORS.includes(data?.errorType)) {
      return {
        result: PollResultCode.TRY_NEXT_BLOCK,
        reason: `OrderBook API Known Error: ${data?.errorType}, ${data?.description}`,
      };
    }
  }

  return {
    result: PollResultCode.UNEXPECTED_ERROR,
    reason: `OrderBook API Unknown Error: ${data?.errorType}, ${data?.description}`,
    error,
  };
}

async function _pollLegacy(
  owner: string,
  chainId: SupportedChainId,
  conditionalOrder: ConditionalOrder,
  contract: ComposableCoW,
  multicall: Multicall3,
  proof: string[],
  offchainInput: string,
  orderRef: string
): Promise<PollResult> {
  // as we going to use multicall, with `aggregate3Value`, there is no need to do any simulation as the
  // calls are guaranteed to pass, and will return the results, or the reversion within the ABI-encoded data.
  // By not using `populateTransaction`, we avoid an `eth_estimateGas` RPC call.
  const logPrefix = `[pollLegacy::${orderRef}]`;
  const to = contract.address;
  const data = contract.interface.encodeFunctionData(
    "getTradeableOrderWithSignature",
    [owner, conditionalOrder.params, offchainInput, proof]
  );

  console.log(
    `${logPrefix} Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${chainId}&contractAddress=${to}&rawFunctionInput=${data}`
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

    // If the call failed, we throw an error and wrap the returnData as it is done by erigon / geth 🦦
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
    // Print and handle the error
    // We need to decide if the error is final or not (if a re-attempt might help). If it doesn't, we delete the order
    return _handleGetTradableOrderCall(error, owner, orderRef);
  }
}

function _handleGetTradableOrderCall(
  error: any,
  owner: string,
  orderRef: string
): PollResultErrors {
  let logPrefix = `[pollLegacy::${orderRef}]`;
  if (error.code === Logger.errors.CALL_EXCEPTION) {
    logPrefix += "Call Exception:";
    // Support raw errors (nethermind issue), and parameterised errors (ethers issue)
    const { errorNameOrSelector } = parseCustomError(error);
    switch (errorNameOrSelector) {
      case "OrderNotValid":
      case ORDER_NOT_VALID_SELECTOR:
        // The conditional order has not expired, or been cancelled, but the order is not valid
        // For example, with TWAPs, this may be after `span` seconds have passed in the epoch.

        // As the `OrderNotValid` is parameterized, we expect `message` to have the reason
        // TODO: Make use of `message` returned by parseCustomError ?

        return {
          result: PollResultCode.TRY_NEXT_BLOCK,
          reason: "OrderNotValid",
        };
      case "SingleOrderNotAuthed":
      case SINGLE_ORDER_NOT_AUTHED_SELECTOR:
        // If there's no authorization we delete the order
        // - One reason could be, because the user CANCELLED the order
        // - for now it doesn't support more advanced cases where the order is auth during a pre-interaction

        console.info(
          `${logPrefix} Single order on safe ${owner} not authed. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason:
            "SingleOrderNotAuthed: The owner has not authorized the order",
        };
      case "ProofNotAuthed":
      case PROOF_NOT_AUTHED_SELECTOR:
        // If there's no authorization we delete the order
        // - One reason could be, because the user CANCELLED the order
        // - for now it doesn't support more advanced cases where the order is auth during a pre-interaction

        console.info(
          `${logPrefix} Proof on safe ${owner} not authed. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: "ProofNotAuthed: The owner has not authorized the order",
        };
      default:
        // If there's no authorization we delete the order
        // - One reason could be, because the user CANCELLED the order
        // - for now it doesn't support more advanced cases where the order is auth during a pre-interaction
        const errorName = error.errorName ? ` (${error.errorName})` : "";
        console.error(`${logPrefix} for unexpected reasons${errorName}`, error);
        // If we don't know the reason, is better to not delete the order
        return {
          result: PollResultCode.TRY_NEXT_BLOCK,
          reason: "UnexpectedErrorName: CALL error is unknown" + errorName,
        };
    }
  }

  console.error(`${logPrefix} Unexpected error`, error);
  // If we don't know the reason, is better to not delete the order
  return {
    result: PollResultCode.TRY_NEXT_BLOCK,
    reason:
      "UnexpectedErrorName: Unspected error" +
      (error.message ? `: ${error.message}` : ""),
  };
}

async function _handleOrderShadowMode(params: {
  orderUid: string;
  conditionalOrderId: string | undefined;
  conditionalOrder: ConditionalOrder;
  blockTimestamp: number;
  pendingOrdersShadowMode: Map<ethers.utils.BytesLike, PendingOrderShadowMode>;
  orderToPost: any;
  logPrefix: string;
  apiUrl: string;
}): Promise<PollResultErrors | undefined> {
  const {
    orderUid,
    conditionalOrderId,
    conditionalOrder,
    blockTimestamp,
    pendingOrdersShadowMode,
    orderToPost,
    logPrefix,
    apiUrl,
  } = params;
  let doNotPostOrderReason;
  const reasonDescription = `Deferred posting ${orderUid} to the API (running in shadow mode).`;

  // Check if orderUid is an order we are already tracking
  const pendingOrderShadowMode = pendingOrdersShadowMode.get(orderUid);
  if (pendingOrderShadowMode) {
    const { firstSeenBlockTimestamp } = pendingOrderShadowMode;
    const secondsElapsed = blockTimestamp - firstSeenBlockTimestamp;
    if (secondsElapsed > SHADOW_MODE_LAG_SECONDS) {
      // Check if order exists in orderbook
      if (await _existsOrderInApi(apiUrl, orderUid)) {
        // ✅ All good, someone did a good job posting the order
        doNotPostOrderReason = `Shadow Mode. Great! Order ${orderUid} was placed in the API by someone else`;
        console.log(`${logPrefix} ${doNotPostOrderReason}`);

        // We won't keep track of the order any more
        pendingOrdersShadowMode.delete(orderUid);
      } else {
        // 🚨 Error, Someone didn't post the order
        console.error(
          `${logPrefix} Shadow Mode. Order ${orderUid} has been over ${Math.floor(
            SHADOW_MODE_LAG_SECONDS / 60
          )} minutes pending to be posted to the API. Some WatchTower might be down`
        );

        // Not returning an error will make the WatchTower to continue and post the order
        return undefined;
      }

      return undefined;
    } else {
      // 🕣 We need to wait longer until we can post the order
      console.log(
        `${logPrefix} Shadow Mode. Deferring the submission of order ${orderUid} (first seen ${secondsElapsed} seconds ago)`
      );
      doNotPostOrderReason = `${reasonDescription} Will post it after ${
        SHADOW_MODE_LAG_SECONDS - secondsElapsed
      } seconds`;
    }
  } else {
    // 📒 Register the order for the first time
    console.log(
      `${logPrefix} Shadow Mode. Deferring the submission of a new order ${orderUid}`
    );

    pendingOrdersShadowMode.set(orderUid, {
      conditionalOrderId,
      firstSeenBlockTimestamp: blockTimestamp,
      order: orderToPost,
      orderUid,
      conditionalOrder,
    });

    doNotPostOrderReason = `${reasonDescription} Will post it after ${Math.floor(
      SHADOW_MODE_LAG_SECONDS / 60
    )} minutes`;
  }

  return {
    result: PollResultCode.TRY_NEXT_BLOCK, // We don't return TRY_AT_EPOCH to try after the lag, because the same conditional order can generate more orders, and some of them could be posted before that
    reason: doNotPostOrderReason,
  };
}

async function _existsOrderInApi(apiUrl: string, orderUid: string) {
  const { status } = await axios
    .get(`${apiUrl}/api/v1/orders/${orderUid}`)
    .catch((err) => err);

  return status === 200;
}

function toOrderApi(order: Order, owner: string, signature: string): any {
  // TODO: This order should be typed, and we should use the SDK (@see OrderCreation type)
  //  Our of the scope, Watch Tower v2 is being done as we speak, so we need to keep the changes minimal and this will likely be rewritten
  const {
    sellToken,
    buyToken,
    receiver,
    sellAmount,
    buyAmount,
    validTo,
    appData,
    feeAmount,
    kind,
    partiallyFillable,
    sellTokenBalance,
    buyTokenBalance,
  } = order;
  return {
    sellToken,
    buyToken,
    receiver,
    validTo,
    appData,
    kind,
    partiallyFillable,
    sellTokenBalance,
    buyTokenBalance,
    from: owner,
    signature,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    feeAmount: feeAmount.toString(),
    signingScheme: "eip1271",
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
