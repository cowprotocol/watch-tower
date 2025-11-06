import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  MAX_UINT32,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { PollResultCode, PollResultErrors } from "@cowprotocol/sdk-composable";
import { BigNumber, ethers } from "ethers";
import { metrics } from ".";
import { ComposableCoW, ComposableCoW__factory } from "../types";
import { getLogger } from "./logging";

// Define an enum for the custom error revert hints that can be returned by the ComposableCoW's interfaces.
export enum CustomErrorSelectors {
  /**
   * The owner has not authorized the order
   */
  PROOF_NOT_AUTHED = "PROOF_NOT_AUTHED",

  /**
   * The owner has not authorized the order
   */
  SINGLE_ORDER_NOT_AUTHED = "SINGLE_ORDER_NOT_AUTHED",

  /**
   * The conditional order didn't pass the swap guard
   */
  SWAP_GUARD_RESTRICTED = "SWAP_GUARD_RESTRICTED",

  /**
   * The handler is not supported
   */
  INVALID_HANDLER = "INVALID_HANDLER",

  /**
   * The Safe doesn't have the extensible fallback handler set
   */
  INVALID_FALLBACK_HANDLER = "INVALID_FALLBACK_HANDLER",

  /**
   * `InterfaceNotSupported` is returned when the contract does not implement the `IERC165` interface
   */
  INTERFACE_NOT_SUPPORTED = "INTERFACE_NOT_SUPPORTED",
  /**
   * `OrderNotValid` is generally returned when elements
   * of the data struct are invalid. For example, if the `sellAmount` is zero, or the `validTo` is in
   * the past
   */
  ORDER_NOT_VALID = "ORDER_NOT_VALID",

  /**
   * The conditional order has signalled that it should be polled again on the next block
   */
  POLL_TRY_NEXT_BLOCK = "POLL_TRY_NEXT_BLOCK",

  /**
   * Stop polling the order
   */
  POLL_NEVER = "POLL_NEVER",

  /**
   * The conditional order has signalled that it should be polled again at the given block number
   */
  POLL_TRY_AT_BLOCK = "POLL_TRY_AT_BLOCK",

  /**
   * The conditional order has signalled that it should be polled again at the given epoch
   */
  POLL_TRY_AT_EPOCH = "POLL_TRY_AT_EPOCH",
}

type ParsedCustomError = {
  [K in CustomErrorSelectors]: K extends
    | CustomErrorSelectors.PROOF_NOT_AUTHED
    | CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED
    | CustomErrorSelectors.INTERFACE_NOT_SUPPORTED
    | CustomErrorSelectors.INVALID_FALLBACK_HANDLER
    | CustomErrorSelectors.INVALID_HANDLER
    | CustomErrorSelectors.SWAP_GUARD_RESTRICTED
    ? { selector: K }
    : K extends
        | CustomErrorSelectors.ORDER_NOT_VALID
        | CustomErrorSelectors.POLL_TRY_NEXT_BLOCK
        | CustomErrorSelectors.POLL_NEVER
    ? { selector: K; message: string }
    : K extends
        | CustomErrorSelectors.POLL_TRY_AT_BLOCK
        | CustomErrorSelectors.POLL_TRY_AT_EPOCH
    ? { selector: K; message: string; blockNumberOrEpoch: number }
    : never;
}[CustomErrorSelectors];

export const CUSTOM_ERROR_ABI_MAP: Record<CustomErrorSelectors, string> = {
  [CustomErrorSelectors.PROOF_NOT_AUTHED]: "ProofNotAuthed()",
  [CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED]: "SingleOrderNotAuthed()",
  [CustomErrorSelectors.SWAP_GUARD_RESTRICTED]: "SwapGuardRestricted()",
  [CustomErrorSelectors.INVALID_HANDLER]: "InvalidHandler()",
  [CustomErrorSelectors.INVALID_FALLBACK_HANDLER]: "InvalidFallbackHandler()",
  [CustomErrorSelectors.INTERFACE_NOT_SUPPORTED]: "InterfaceNotSupported()",
  [CustomErrorSelectors.ORDER_NOT_VALID]: "OrderNotValid(string)",
  [CustomErrorSelectors.POLL_TRY_NEXT_BLOCK]: "PollTryNextBlock(string)",
  [CustomErrorSelectors.POLL_NEVER]: "PollNever(string)",
  [CustomErrorSelectors.POLL_TRY_AT_BLOCK]: "PollTryAtBlock(uint256,string)",
  [CustomErrorSelectors.POLL_TRY_AT_EPOCH]: "PollTryAtEpoch(uint256,string)",
};

// Process the CUSTOM_ERROR_ABI_MAP to change the values to the ABI-encoded selectors
const CUSTOM_ERROR_SELECTOR_MAP = generateCustomErrorSelectorMap();

export function abiToSelector(abi: string) {
  return ethers.utils.id(abi).slice(0, 10);
}

export function composableCowContract(
  provider: ethers.providers.Provider,
  chainId: SupportedChainId
): ComposableCoW {
  return ComposableCoW__factory.connect(
    COMPOSABLE_COW_CONTRACT_ADDRESS[chainId],
    provider
  );
}

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and any parameters.
 * @param revertData ABI-encoded custom error, which may or may not be parameterized.
 * @returns {ParsedCustomError} an object containing the selector and any parameters.
 * @throws if the revert data is not at least 4 bytes long (8 hex characters, 0x prefixed), or if the
 * revert data contains a selector that is not in the CUSTOM_ERROR_SELECTOR_MAP, or if the revert data
 * contains a selector that is in the CUSTOM_ERROR_SELECTOR_MAP, but the it's parameters are not ABI-encoded
 * correctly.
 */
export function parseCustomError(revertData: string): ParsedCustomError {
  // If the revert data is not at least 4 bytes long (8 hex characters, 0x prefixed), it cannot contain a selector
  if (revertData.length < 10) {
    throw new Error("Revert data too short to contain a selector");
  }

  const rawSelector = revertData.slice(0, 10);

  // If the revert data does not contain a selector from the CUSTOM_ERROR_SELECTOR_MAP, it is a non-compliant
  // interface and we should signal to drop it.
  if (!(revertData.slice(0, 10) in CUSTOM_ERROR_SELECTOR_MAP)) {
    throw new Error(
      "On-chain hint / custom error not compliant with ComposableCoW interface"
    );
  }

  // Below here, the only throw that can happen is if the revert data contains a selector that is in the
  // CUSTOM_ERROR_SELECTOR_MAP, but the it's parameters are not ABI-encoded correctly.

  const selector = CUSTOM_ERROR_SELECTOR_MAP[rawSelector];
  const fragment = ethers.utils.Fragment.fromString(
    "error " + CUSTOM_ERROR_ABI_MAP[selector]
  );
  const iface = new ethers.utils.Interface([fragment]);

  switch (selector) {
    case CustomErrorSelectors.PROOF_NOT_AUTHED:
    case CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED:
    case CustomErrorSelectors.INTERFACE_NOT_SUPPORTED:
    case CustomErrorSelectors.INVALID_FALLBACK_HANDLER:
    case CustomErrorSelectors.INVALID_HANDLER:
    case CustomErrorSelectors.SWAP_GUARD_RESTRICTED:
      return { selector };
    case CustomErrorSelectors.ORDER_NOT_VALID:
    case CustomErrorSelectors.POLL_TRY_NEXT_BLOCK:
    case CustomErrorSelectors.POLL_NEVER:
      const [message] = iface.decodeErrorResult(fragment, revertData) as [
        string
      ];
      return { selector, message };
    case CustomErrorSelectors.POLL_TRY_AT_BLOCK:
    case CustomErrorSelectors.POLL_TRY_AT_EPOCH:
      const [blockNumberOrEpoch, msg] = iface.decodeErrorResult(
        fragment,
        revertData
      ) as [BigNumber, string];

      // It is reasonable to expect that the block number or epoch is bound by
      // uint32. It is therefore safe to throw if the value is outside of that
      // for javascript's number type.
      if (blockNumberOrEpoch.gt(MAX_UINT32)) {
        throw new Error("Block number or epoch out of bounds");
      }

      return {
        selector,
        message: msg,
        blockNumberOrEpoch: blockNumberOrEpoch.toNumber(),
      };
  }
}

/**
 * Given a raw ABI-encoded custom error returned from a revert, determine subsequent polling actions.
 * This function will swallow any errors thrown by `parseCustomError` and return a DONT_TRY_AGAIN result.
 */
export function handleOnChainCustomError(params: {
  owner: string;
  chainId: SupportedChainId;
  target: string;
  callData: string;
  revertData: string;
  metricLabels: string[];
  blockNumber: number;
  ownerNumber: number;
  orderNumber: number;
}): PollResultErrors {
  const {
    owner,
    chainId,
    target,
    callData,
    revertData,
    metricLabels,
    blockNumber,
    ownerNumber,
    orderNumber,
  } = params;
  const loggerParams = {
    name: "handleOnChainCustomError",
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  };

  try {
    // The below will throw if:
    // - the error is not a custom error (ie. the selector is not in the map)
    // - the error is a custom error, but the parameters are not as expected
    const parsedCustomError = parseCustomError(revertData);
    const { selector } = parsedCustomError;
    const log = getLogger({
      ...loggerParams,
      args: [selector],
    });
    const msgWithSelector = (message: string): string =>
      `${selector}: ${message}`;
    const dropOrder = (reason: string): PollResultErrors => {
      return {
        result: PollResultCode.DONT_TRY_AGAIN,
        reason: msgWithSelector(reason),
      };
    };
    switch (parsedCustomError.selector) {
      case CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED:
      case CustomErrorSelectors.PROOF_NOT_AUTHED:
        // If there's no authorization we delete the order
        // - One reason could be, because the user CANCELLED the order
        // - for now it doesn't support more advanced cases where the order is authed during a pre-interaction
        log.info(`Order on safe ${owner} not authed. Deleting order...`);
        return dropOrder("The owner has not authorized the order");
      case CustomErrorSelectors.INTERFACE_NOT_SUPPORTED:
        log.info(
          `Order type for safe ${owner}, failed IERC165 introspection check. Deleting order...`
        );
        return dropOrder("The order type failed IERC165 introspection check");
      case CustomErrorSelectors.INVALID_FALLBACK_HANDLER:
        log.info(
          `Order for safe ${owner} where the Safe does not have ExtensibleFallbackHandler set. Deleting order...`
        );
        return dropOrder(
          "The safe does not have ExtensibleFallbackHandler set"
        );
      case CustomErrorSelectors.INVALID_HANDLER:
        log.info(
          `Order on safe ${owner} attempted to use a handler that is not supported. Deleting order...`
        );
        return dropOrder("The handler is not supported");
      case CustomErrorSelectors.SWAP_GUARD_RESTRICTED:
        log.info(
          `Order for safe ${owner} where the Safe has swap guard enabled. Deleting order...`
        );
        return dropOrder("The conditional order didn't pass the swap guard");
      case CustomErrorSelectors.ORDER_NOT_VALID:
        const reason = msgWithSelector(parsedCustomError.message);
        log.info(
          `Order for ${owner} is invalid. Reason: ${reason}. Deleting order...`
        );
        return dropOrder(`Invalid order: ${reason}`);
      case CustomErrorSelectors.POLL_TRY_NEXT_BLOCK:
        log.info(`Order on safe ${owner} not signalled to try next block`);
        return {
          result: PollResultCode.TRY_NEXT_BLOCK,
          reason: msgWithSelector(parsedCustomError.message),
        };
      case CustomErrorSelectors.POLL_TRY_AT_BLOCK:
        return {
          result: PollResultCode.TRY_ON_BLOCK,
          blockNumber: parsedCustomError.blockNumberOrEpoch,
          reason: msgWithSelector(parsedCustomError.message),
        };
      case CustomErrorSelectors.POLL_TRY_AT_EPOCH:
        return {
          result: PollResultCode.TRY_AT_EPOCH,
          epoch: parsedCustomError.blockNumberOrEpoch,
          reason: msgWithSelector(parsedCustomError.message),
        };
      case CustomErrorSelectors.POLL_NEVER:
        return dropOrder(parsedCustomError.message);
    }
  } catch (err: any) {
    // Any errors thrown here can _ONLY_ come from non-compliant interfaces (ie. bad revert ABI encoding).
    // We log the error, and return a DONT_TRY_AGAIN result.
    const log = getLogger(loggerParams);

    log.debug(
      `Non-compliant interface error thrown${
        err.message ? `: ${err.message}` : ""
      }`
    );
    log.debug(
      `Contract returned a non-compliant interface revert via getTradeableOrderWithSignature. Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${chainId}&contractAddress=${target}&rawFunctionInput=${callData}`
    );
    metrics.pollingOnChainInvalidInterfacesTotal.labels(...metricLabels).inc();
    return {
      result: PollResultCode.DONT_TRY_AGAIN,
      reason: "Order returned a non-compliant (invalid/erroneous) revert hint",
    };
  }
}

function generateCustomErrorSelectorMap(): Record<
  string,
  CustomErrorSelectors
> {
  const CUSTOM_ERROR_SELECTOR_MAP: Record<string, CustomErrorSelectors> = {};

  for (const errorType of Object.keys(
    CUSTOM_ERROR_ABI_MAP
  ) as CustomErrorSelectors[]) {
    const selector = abiToSelector(CUSTOM_ERROR_ABI_MAP[errorType]);
    CUSTOM_ERROR_SELECTOR_MAP[selector] = errorType;
  }

  return CUSTOM_ERROR_SELECTOR_MAP;
}
