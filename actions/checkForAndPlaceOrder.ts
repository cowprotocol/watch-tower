import { ActionFn, BlockEvent, Context, Event } from "@tenderly/actions";
import {
  Order,
  OrderBalance,
  OrderKind,
  computeOrderUid,
} from "@cowprotocol/contracts";

import axios from "axios";

import { ethers, utils } from "ethers";
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
import { ChainContext, ConditionalOrder, OrderStatus } from "./model";
import { pollConditionalOrder } from "./utils/poll";
import {
  PollResult,
  PollResultCode,
  PollResultErrors,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

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
  const { network } = blockEvent;
  const chainId = toChainId(network);
  const chainContext = await ChainContext.create(context, chainId);
  const { registry } = await initContext(
    "checkForAndPlaceOrder",
    chainId,
    context
  );
  const { ownerOrders } = registry;

  // enumerate all the owners
  let hasErrors = false;
  let ownerCount = 0;
  let orderCount = 0;

  if (ownerOrders.size > 0) {
    console.log(`[checkForAndPlaceOrder] New Block ${blockEvent.blockNumber}`);
  }
  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCount++;
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    console.log(
      `[checkForAndPlaceOrder::${ownerCount}] Process owner ${owner} (${conditionalOrders.size} orders)`
    );
    for (const conditionalOrder of conditionalOrders) {
      orderCount++;
      const logPrefix = `[checkForAndPlaceOrder::${ownerCount}.${orderCount}]`;
      console.log(
        `${logPrefix} Check conditional order created in TX ${conditionalOrder.tx} with params:`,
        conditionalOrder.params
      );
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
        contract,
        multicall,
        chainContext
      );
      const error = pollResult !== undefined;

      // Specific handling for each error
      if (pollResult) {
        // Dont try again the same order
        if (pollResult.result === PollResultCode.DONT_TRY_AGAIN) {
          ordersPendingDelete.push(conditionalOrder);
        }

        // TODO: Handle the other errors :) --> Store them in the registry and ignore blocks until the moment is right
        //  TRY_ON_BLOCK
        //  TRY_AT_EPOCH
      }

      // Log the result
      const resultDescription =
        pollResult !== undefined
          ? `❌ ${pollResult.result}${
              pollResult.reason ? `. Reason: ${pollResult.reason}` : ""
            }`
          : "✅ SUCCESS";
      console[error ? "error" : "log"](
        `${logPrefix} Check conditional order result: ${resultDescription}`
      );
      if (pollResult?.result === PollResultCode.UNEXPECTED_ERROR) {
        console.error(
          `${logPrefix} UNEXPECTED_ERROR Details:`,
          pollResult.error
        );
      }

      hasErrors ||= error;
    }

    // Delete orders we don't want to keep watching
    for (const conditionalOrder of ordersPendingDelete) {
      const deleted = conditionalOrders.delete(conditionalOrder);
      const action = deleted ? "Deleted" : "Fail to delete";
      console.log(
        `[checkForAndPlaceOrder] ${action} conditional order with params:`,
        conditionalOrder.params
      );
    }
  }

  // Delete owners with no orders
  for (const [owner, conditionalOrders] of Array.from(ownerOrders.entries())) {
    if (conditionalOrders.size === 0) {
      ownerOrders.delete(owner);
    }
  }

  // Update the registry
  hasErrors ||= await !writeRegistry();

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(
      "[checkForAndPlaceOrder] At least one unexpected error processing conditional orders"
    );
  }
};

async function _processConditionalOrder(
  owner: string,
  chainId: SupportedChainId,
  conditionalOrder: ConditionalOrder,
  contract: ComposableCoW,
  multicall: Multicall3,
  chainContext: ChainContext
): Promise<PollResultErrors | undefined> {
  let error = false;
  try {
    // Do custom Conditional Order checks
    // const [handler, salt, staticInput] = await (() => {
    //   const [handler, salt, staticInput ] = conditionalOrder.params;
    //   return Promise.all([handler, salt, staticInput]);
    // })();
    // console.log("TODO: Why now this parameters seem broken????? ", {
    //   handler,
    //   salt,
    //   staticInput,
    //   params: conditionalOrder.params,
    // });

    const [handler, salt, staticInput] = conditionalOrder.params as any as [
      string,
      string,
      string
    ];

    let pollResult = await pollConditionalOrder({
      owner,
      chainId,
      conditionalOrderParams: {
        handler,
        staticInput,
        salt,
      },
      provider: chainContext.provider,
    });

    if (!pollResult) {
      // Unsupported Order Type (unknown handler)
      // For now, fallback to legacy behavior
      // TODO: Decide in the future what to do. Probably, move the error handling to the SDK and kill the poll Legacy
      pollResult = await _pollLegacy(
        owner,
        chainId,
        conditionalOrder,
        contract,
        multicall
      );
    }

    // Error polling
    if (pollResult.result !== PollResultCode.SUCCESS) {
      return pollResult;
    }

    const { order, signature } = pollResult;

    const orderToSubmit: Order = {
      ...order,
      kind: kindToString(order.kind),
      sellTokenBalance: balanceToString(order.sellTokenBalance),
      buyTokenBalance: balanceToString(order.buyTokenBalance),
    };

    // calculate the orderUid
    const orderUid = _getOrderUid(chainId, orderToSubmit, owner);

    // if the orderUid has not been submitted, or filled, then place the order
    if (!conditionalOrder.orders.has(orderUid)) {
      await _placeOrder(
        orderUid,
        { ...orderToSubmit, from: owner, signature },
        chainContext.apiUrl
      );

      conditionalOrder.orders.set(orderUid, OrderStatus.SUBMITTED);
    } else {
      const orderStatus = conditionalOrder.orders.get(orderUid);
      console.log(
        `OrderUid ${orderUid} status: ${
          orderStatus ? formatStatus(orderStatus) : "Not found"
        }`
      );
    }
  } catch (e: any) {
    return {
      result: PollResultCode.UNEXPECTED_ERROR,
      error: e,
      reason:
        "Unhandled error processing conditional order" +
        (e.message ? `: ${e.message}` : ""),
    };
  }

  // Success!
  return undefined;
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
async function _placeOrder(
  orderUid: string,
  order: any,
  apiUrl: string
): Promise<void> {
  try {
    const postData = {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      validTo: order.validTo,
      appData: order.appData,
      feeAmount: order.feeAmount.toString(),
      kind: order.kind,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: order.sellTokenBalance,
      buyTokenBalance: order.buyTokenBalance,
      signingScheme: "eip1271",
      signature: order.signature,
      from: order.from,
    };

    // if the apiUrl doesn't contain localhost, post
    console.log(`[placeOrder] Post order ${orderUid} to ${apiUrl}`);
    console.log(`[placeOrder] Order`, postData);
    if (!apiUrl.includes("localhost")) {
      const { status, data } = await axios.post(
        `${apiUrl}/api/v1/orders`,
        postData,
        {
          headers: {
            "Content-Type": "application/json",
            accept: "application/json",
          },
        }
      );
      console.log(`[placeOrder] API response`, { status, data });
    }
  } catch (error: any) {
    const errorMessage = "[placeOrder] Error placing order in API";
    if (error.response) {
      const { status, data } = error.response;

      const { shouldThrow } = _handleOrderBookError(status, data);

      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      const log = console[shouldThrow ? "error" : "warn"];
      log(`${errorMessage}. Result: ${status}`, data);

      if (!shouldThrow) {
        log("All good! continuing with warnings...");
        return;
      }
    } else if (error.request) {
      // The request was made but no response was received
      // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
      // http.ClientRequest in node.js
      console.error(`${errorMessage}. Unresponsive API: ${error.request}`);
    } else if (error.message) {
      // Something happened in setting up the request that triggered an Error
      console.error(`${errorMessage}. Internal Error: ${error.message}`);
    } else {
      console.error(`${errorMessage}. Unhandled Error: ${error.message}`);
    }
    throw error;
  }
}

function _handleOrderBookError(
  status: any,
  data: any
): { shouldThrow: boolean } {
  if (status === 400 && data?.errorType === "DuplicatedOrder") {
    // The order is in the OrderBook, all good :)
    return { shouldThrow: false };
  }

  return { shouldThrow: true };
}

async function _pollLegacy(
  owner: string,
  chainId: SupportedChainId,
  conditionalOrder: ConditionalOrder,
  contract: ComposableCoW,
  multicall: Multicall3
): Promise<PollResult> {
  const proof = conditionalOrder.proof ? conditionalOrder.proof.path : [];
  const offchainInput = "0x";

  // as we going to use multicall, with `aggregate3Value`, there is no need to do any simulation as the
  // calls are guaranteed to pass, and will return the results, or the reversion within the ABI-encoded data.
  // By not using `populateTransaction`, we avoid an `eth_estimateGas` RPC call.
  const to = contract.address;
  const data = contract.interface.encodeFunctionData(
    "getTradeableOrderWithSignature",
    [owner, conditionalOrder.params, offchainInput, proof]
  );

  console.log(
    `[pollLegacy] Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${chainId}&contractAddress=${to}&rawFunctionInput=${data}`
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
    return _handleGetTradableOrderCall(error, owner);
  }
}

function _handleGetTradableOrderCall(
  error: any,
  owner: string
): PollResultErrors {
  if (error.code === Logger.errors.CALL_EXCEPTION) {
    const errorMessagePrefix = "[pollLegacy] Call Exception";

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
          `${errorMessagePrefix}: Single order on safe ${owner} not authed. Deleting order...`
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
          `${errorMessagePrefix}: Proof on safe ${owner} not authed. Deleting order...`
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
        console.error(
          `${errorMessagePrefix} for unexpected reasons${errorName}`,
          error
        );
        // If we don't know the reason, is better to not delete the order
        return {
          result: PollResultCode.TRY_NEXT_BLOCK,
          reason: "UnexpectedErrorName: CALL error is unknown" + errorName,
        };
    }
  }

  console.error("[pollLegacy] Unexpected error", error);
  // If we don't know the reason, is better to not delete the order
  return {
    result: PollResultCode.TRY_NEXT_BLOCK,
    reason:
      "UnexpectedErrorName: Unspected error" +
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
