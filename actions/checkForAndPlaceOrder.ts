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

import { ComposableCoW, ComposableCoW__factory } from "./types";
import {
  formatStatus,
  handleExecutionError,
  init,
  writeRegistry,
} from "./utils";
import {
  ChainContext,
  ConditionalOrder,
  OrderStatus,
  SmartOrderValidationResult,
  ValidationResult,
} from "./model";
import { GPv2Order } from "./types/ComposableCoW";
import { validateOrder } from "./handlers";

const GPV2SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

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
  const chainContext = await ChainContext.create(context, network);
  const { registry } = await init(
    "checkForAndPlaceOrder",
    blockEvent.network,
    context
  );
  const { ownerOrders } = registry;

  // enumerate all the owners
  let hasErrors = false;
  console.log(`[checkForAndPlaceOrder] New Block ${blockEvent.blockNumber}`);
  for (const [owner, conditionalOrders] of ownerOrders.entries()) {
    const ordersPendingDelete = [];
    // enumerate all the `ConditionalOrder`s for a given owner
    for (const conditionalOrder of conditionalOrders) {
      console.log(
        `[checkForAndPlaceOrder] Check conditional order created in TX ${conditionalOrder.tx} with params:`,
        conditionalOrder.params
      );
      const contract = ComposableCoW__factory.connect(
        conditionalOrder.composableCow,
        chainContext.provider
      );

      const { deleteConditionalOrder, error } = await _processConditionalOrder(
        owner,
        network,
        conditionalOrder,
        contract,
        chainContext,
        context
      );

      console.log(
        `[checkForAndPlaceOrder] Check conditional order result: ${
          error ? "❌" : "✅"
        }`
      );

      hasErrors ||= error;

      if (deleteConditionalOrder) {
        ordersPendingDelete.push(conditionalOrder);
      }
    }

    for (const conditionalOrder of ordersPendingDelete) {
      const deleted = conditionalOrders.delete(conditionalOrder);
      const action = deleted ? "Deleted" : "Fail to delete";
      console.log(
        `[checkForAndPlaceOrder] ${action} conditional order with params:`,
        conditionalOrder.params
      );
    }
  }

  // Update the registry
  hasErrors ||= await !writeRegistry();

  // Throw execution error if there was at least one error
  if (hasErrors) {
    throw Error(
      "[checkForAndPlaceOrder] Error while checking if conditional orders are ready to be placed in Orderbook API"
    );
  }
};

async function _processConditionalOrder(
  owner: string,
  network: string,
  conditionalOrder: ConditionalOrder,
  contract: ComposableCoW,
  chainContext: ChainContext,
  context: Context
): Promise<{ deleteConditionalOrder: boolean; error: boolean }> {
  let error = false;
  try {
    // Do a basic auth check (for singleOrders) // TODO: Check also Merkle auth
    // Check in case the user invalidated it (this reduces errors in logs)
    if (!conditionalOrder.proof) {
      const ctx = await contract.callStatic.hash(conditionalOrder.params);
      const authorised = await contract.callStatic
        .singleOrders(owner, ctx)
        .catch((error) => {
          console.log(
            "[processConditionalOrder] Error checking singleOrders auth",
            { owner, ctx, conditionalOrder },
            error
          );
          return undefined; // returns undefined if it cannot be checked
        });

      // Return early if the order is not authorised (if its not authorised)
      // Note we continue in case of an error (this is just to let _getTradeableOrderWithSignature handle the error and log the Tenderly simulation link)
      if (authorised === false) {
        console.log(
          `[processConditionalOrder] Single order not authed. Deleting order...`,
          { owner, ctx, conditionalOrder }
        );
        return { deleteConditionalOrder: true, error: false };
      }
    }

    // Do custom Conditional Order checks
    const [handler, salt, staticInput] = await (() => {
      const { handler, salt, staticInput } = conditionalOrder.params;
      return Promise.all([handler, salt, staticInput]);
    })();
    const validateResult = await validateOrder({
      handler,
      salt,
      staticInput,
    });
    if (validateResult && validateResult.result !== ValidationResult.Success) {
      const { result, deleteConditionalOrder } = validateResult;
      return {
        error: result !== ValidationResult.FailedButIsExpected, // If we expected the call to fail, then we don't consider it an error
        deleteConditionalOrder,
      };
    }

    // Get GPv2 Order
    const tradeableOrderResult = await _getTradeableOrderWithSignature(
      owner,
      network,
      conditionalOrder,
      contract
    );

    // Return early if the simulation fails
    if (tradeableOrderResult.result != ValidationResult.Success) {
      const { deleteConditionalOrder, result } = tradeableOrderResult;
      return {
        error: result !== ValidationResult.FailedButIsExpected, // If we expected the call to fail, then we don't consider it an error
        deleteConditionalOrder,
      };
    }

    const { order, signature } = tradeableOrderResult.data;

    const orderToSubmit: Order = {
      ...order,
      kind: kindToString(order.kind),
      sellTokenBalance: balanceToString(order.sellTokenBalance),
      buyTokenBalance: balanceToString(order.buyTokenBalance),
    };

    // calculate the orderUid
    const orderUid = _getOrderUid(network, orderToSubmit, owner);

    // if the orderUid has not been submitted, or filled, then place the order
    if (!conditionalOrder.orders.has(orderUid)) {
      await _placeOrder(
        orderUid,
        { ...orderToSubmit, from: owner, signature },
        chainContext.api_url
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
    error = true;
    console.error(
      `[_processConditionalOrder] Unexpected error while processing order:`,
      e
    );
  }

  return { deleteConditionalOrder: false, error };
}

function _getOrderUid(network: string, orderToSubmit: Order, owner: string) {
  return computeOrderUid(
    {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: network,
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

export type TradableOrderWithSignatureResult = SmartOrderValidationResult<{
  order: GPv2Order.DataStructOutput;
  signature: string;
}>;

async function _getTradeableOrderWithSignature(
  owner: string,
  network: string,
  conditionalOrder: ConditionalOrder,
  contract: ComposableCoW
): Promise<TradableOrderWithSignatureResult> {
  const proof = conditionalOrder.proof ? conditionalOrder.proof.path : [];
  const offchainInput = "0x";
  const { to, data } =
    await contract.populateTransaction.getTradeableOrderWithSignature(
      owner,
      conditionalOrder.params,
      offchainInput,
      proof
    );

  console.log(
    `[getTradeableOrderWithSignature] Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${network}&contractAddress=${to}&rawFunctionInput=${data}`
  );

  try {
    const data = await contract.callStatic.getTradeableOrderWithSignature(
      owner,
      conditionalOrder.params,
      offchainInput,
      proof
    );

    return {
      result: ValidationResult.Success,
      data,
    };
  } catch (error: any) {
    // Print and handle the error
    // We need to decide if the error is final or not (if a re-attempt might help). If it doesn't, we delete the order
    const { result, deleteConditionalOrder } = _handleGetTradableOrderCall(
      error,
      owner
    );
    return {
      result,
      deleteConditionalOrder,
      errorObj: error,
    };
  }
}

function _handleGetTradableOrderCall(
  error: any,
  owner: string
): {
  result: ValidationResult.Failed | ValidationResult.FailedButIsExpected;
  deleteConditionalOrder: boolean;
} {
  if (error.code === Logger.errors.CALL_EXCEPTION) {
    const errorMessagePrefix =
      "[getTradeableOrderWithSignature] Call Exception";

    // Support raw errors (nethermind issue), and parameterised errors (ethers issue)
    const { errorNameOrSelector, message } = parseCustomError(error);
    switch (errorNameOrSelector) {
      case "OrderNotValid":
      case ORDER_NOT_VALID_SELECTOR:
        // The conditional order has not expired, or been cancelled, but the order is not valid
        // For example, with TWAPs, this may be after `span` seconds have passed in the epoch.

        // As the `OrderNotValid` is parameterized, we expect `message` to have the reason
        // TODO: Make use of `message` ?
        // console.log(message)

        return {
          result: ValidationResult.FailedButIsExpected,
          deleteConditionalOrder: false,
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
          result: ValidationResult.FailedButIsExpected,
          deleteConditionalOrder: true,
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
          result: ValidationResult.FailedButIsExpected,
          deleteConditionalOrder: true,
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
          result: ValidationResult.Failed,
          deleteConditionalOrder: false,
        };
    }
  }

  console.error("[getTradeableOrderWithSignature] Unexpected error", error);
  // If we don't know the reason, is better to not delete the order
  return { result: ValidationResult.Failed, deleteConditionalOrder: false };
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

// These are the `sighash` of the custom errors, with sighashes being calculated the same way for custom
// errors as they are for functions in solidity.
const ORDER_NOT_VALID_SELECTOR = "0xc8fc2725";
const SINGLE_ORDER_NOT_AUTHED_SELECTOR = "0x7a933234";
const PROOF_NOT_AUTHED_SELECTOR = "0x4a821464";

type ParsedError = {
  errorNameOrSelector?: string;
  message?: string;
}

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and optionally a message.
 * @param abi of the custom error, which may or may not be parameterised.
 * @returns an empty parsed error if assumptions don't hold, otherwise the selector and message if applicable.
 */
const rawErrorDecode = (abi: string): ParsedError  => {
  if (abi.length == 10) {
    return { errorNameOrSelector: abi }
  } else {
    try {
      const selector = String(abi).substring(0, 10);
      const message = ethers.utils.defaultAbiCoder.decode(
        ["string"],
        abi.slice(10) // trim off the selector
      )[0];
      return { errorNameOrSelector: selector, message };
    } catch {
      // some weird parameter, just return and let the caller deal with it
      return {};
    }  
  }
}

/**
 * Parse custom reversion errors, irrespective of the RPC node's software
 * 
 * Background: `ComposableCoW` makes extensive use of `revert` to provide custom error messages. Unfortunately,
 *             different RPC nodes handle these errors differently. For example, Nethermind returns a zero-bytes
 *             `error.data` in all cases, and the error selector is buried in `error.error.error.data`. Other 
 *             nodes return the error selector in `error.data`.
 * 
 *             In all cases, if the error selector contains a parameterised error message, the error message is
 *             encoded in the `error.data` field. For example, `OrderNotValid` contains a parameterised error
 *             message, and the error message is encoded in `error.data`.
 * 
 * Assumptions:
 * - `error.data` exists for all tested RPC nodes, and parameterised / non-parameterised custom errors.
 * - All calls to the smart contract if they revert, return a non-zero result at **EVM** level.
 * - Nethermind, irrespective of the revert reason, returns a zero-bytes `error.data` due to odd message
 *   padding on the RPC return value from Nethermind.
 * Therefore:
 * - Nethermind: `error.data` in a revert case is `0x` (empty string), with the revert reason buried in
 *   `error.error.error.data`.
 * - Other nodes: `error.data` in a revert case we expected the revert reason / custom error selector.
 * @param error returned by ethers
 */
const parseCustomError = (error: any): ParsedError => {
  const { errorName, data } = error;

  // In all cases, data must be defined. If it isn't, return early - bad assumptions.
  if (!data) {
    return {};
  }

  // If error.errorName is defined:
  // - The node has formatted the error message in a way that ethers can parse
  // - It's not a parameterised custom error - no message
  // - We can return early
  if (errorName) {
    return { errorNameOrSelector: errorName };
  }

  // If error.data is not zero-bytes, then it's not a Nethermind node, assume it's a string parameterised
  // custom error. Attempt to decode and return.
  if (data !== "0x") {
    return rawErrorDecode(data)
  } else {
    // This is a Nethermind node, as `data` *must* be equal to `0x`, but we know we always revert with an
    // message, so - we have to go digging ⛏️🙄
    //
    // Verify our assumption that `error.error.error.data` is defined and is a string.
    // TODO: Is there a better way to do this?
    if (
      error.error &&
      error.error.error &&
      typeof error.error.error.data === "string"
    ) {
      const rawNethermind = error.error.error.data // readable, too much inception-level nesting otherwise

      // For some reason, Nethermind pad their message with `Reverted `, so, we need to slice off the 
      // extraneous part of the message, and just get the data - that we wanted in the first place!
      const nethermindData = rawNethermind.slice(9)
      return rawErrorDecode(nethermindData)
    } else {
      // the nested error-ception for some reason failed and our assumptions are therefore incorrect.
      // return the unknown state to the caller.
      return {}
    }
  }
}