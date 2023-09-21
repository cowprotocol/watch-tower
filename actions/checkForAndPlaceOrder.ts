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
import { ChainContext, ConditionalOrder, OrderStatus } from "./model";
import { pollConditionalOrder } from "./utils/poll";
import {
  PollParams,
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  PollResultTryNextBlock,
  PollResultUnexpectedError,
  SupportedChainId,
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
  const { registry } = await initContext(
    "checkForAndPlaceOrder",
    chainId,
    context
  );
  const { ownerOrders } = registry;

  let hasErrors = false;
  let ownerCounter = 0;
  let orderCounter = 0;

  const { timestamp: blockTimestamp } = await chainContext.provider.getBlock(
    blockNumber
  );

  console.log(
    `[checkForAndPlaceOrder@${blockNumber}] Number of orders: `,
    registry.numOrders
  );

  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    ownerCounter++;
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    console.log(
      `[checkForAndPlaceOrder::${ownerCounter}@${blockNumber}] Process owner ${owner} (${conditionalOrders.size} orders)`
    );
    for (const conditionalOrder of conditionalOrders) {
      orderCounter++;
      const orderRef = `${ownerCounter}.${orderCounter}@${blockNumber}}`;
      const logPrefix = `[checkForAndPlaceOrder::${orderRef}]`;
      const logOrderDetails = `Processing order from TX ${conditionalOrder.tx} with params:`;

      const { result: lastResult } = conditionalOrder.pollResult || {};

      // Check if the order is due (by epoch)
      if (
        lastResult?.result === PollResultCode.TRY_AT_EPOCH &&
        lastResult.epoch < blockTimestamp
      ) {
        console.log(
          `${logPrefix} Skipping conditional. Reason: Not due yet (TRY_AT_EPOCH=${lastResult.epoch}). ${logOrderDetails}`,
          conditionalOrder.params
        );
        continue;
      }

      // Check if the order is due (by blockNumber)
      if (
        lastResult?.result === PollResultCode.TRY_ON_BLOCK &&
        lastResult.blockNumber < blockNumber
      ) {
        console.log(
          `${logPrefix} Skipping conditional. Reason: Not due yet (TRY_ON_BLOCK=${lastResult.blockNumber}). ${logOrderDetails}`,
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
        orderRef
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
        `[checkForAndPlaceOrder@${blockNumber}] ${action} conditional order with params:`,
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

  console.log(
    `[checkForAndPlaceOrder@${blockNumber}] Remaining orders: `,
    registry.numOrders
  );

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(
      `[checkForAndPlaceOrder@${blockNumber}] At least one unexpected error processing conditional orders`
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
  orderRef: string
): Promise<PollResult> {
  try {
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
    let pollResult = await pollConditionalOrder(
      pollParams,
      conditionalOrderParams,
      orderRef
    );

    if (!pollResult) {
      // Unsupported Order Type (unknown handler)
      // For now, fallback to legacy behavior
      // TODO: Decide in the future what to do. Probably, move the error handling to the SDK and kill the poll Legacy
      pollResult = await _pollLegacy(
        owner,
        chainId,
        conditionalOrder,
        contract,
        multicall,
        proof,
        offchainInput,
        orderRef
      );
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
      const placeOrderResult = await _placeOrder(
        orderUid,
        { ...orderToSubmit, from: owner, signature },
        chainContext.apiUrl,
        orderRef
      );

      // In case of error, return early
      if (placeOrderResult.result !== PollResultCode.SUCCESS) {
        return placeOrderResult;
      }

      // Mark order as submitted
      conditionalOrder.orders.set(orderUid, OrderStatus.SUBMITTED);
    } else {
      const orderStatus = conditionalOrder.orders.get(orderUid);
      console.log(
        `[processConditionalOrder::${orderRef}] OrderUid ${orderUid} status: ${
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
async function _placeOrder(
  orderUid: string,
  order: any,
  apiUrl: string,
  orderRef: string
): Promise<
  | Omit<PollResultSuccess, "order" | "signature">
  | PollResultTryNextBlock
  | PollResultUnexpectedError
> {
  const logPrefix = `[placeOrder::${orderRef}]`;
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
    console.log(`${logPrefix} Post order ${orderUid} to ${apiUrl}`);
    console.log(`${logPrefix} Order`, postData);
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
      console.log(`${logPrefix} API response`, { status, data });
    }
  } catch (error: any) {
    let reasonError = "Error placing order in API";
    if (error.response) {
      const { status, data } = error.response;

      const handleErrorResult = _handleOrderBookError(status, data, error);
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

function _handleOrderBookError(
  status: any,
  data: any,
  error: any
):
  | Omit<PollResultSuccess, "order" | "signature">
  | PollResultTryNextBlock
  | PollResultUnexpectedError {
  if (status === 400) {
    // The order is in the OrderBook, all good :)
    if (data?.errorType === "DuplicatedOrder") {
      return {
        result: PollResultCode.SUCCESS,
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
