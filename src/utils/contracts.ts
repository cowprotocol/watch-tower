import { ethers } from "ethers";
import { ComposableCoW, ComposableCoW__factory } from "../types";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  MAX_UINT32,
  PollResultCode,
  PollResultErrors,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { getLogger } from "./logging";

// Selectors that are required to be part of the contract's bytecode in order to be considered compatible
const REQUIRED_SELECTORS = [
  "cabinet(address,bytes32)",
  "getTradeableOrderWithSignature(address,(address,bytes32,bytes),bytes,bytes32[])",
];

// Define an enum for the custom errors that can be returned by the ComposableCoW contract
export enum CustomErrorSelectors {
  PROOF_NOT_AUTHED = "PROOF_NOT_AUTHED",
  SINGLE_ORDER_NOT_AUTHED = "SINGLE_ORDER_NOT_AUTHED",
  SWAP_GUARD_RESTRICTED = "SWAP_GUARD_RESTRICTED",
  INVALID_HANDLER = "INVALID_HANDLER",
  INVALID_FALLBACK_HANDLER = "INVALID_FALLBACK_HANDLER",
  INTERFACE_NOT_SUPPORTED = "INTERFACE_NOT_SUPPORTED",
  ORDER_NOT_VALID = "ORDER_NOT_VALID",
  POLL_TRY_NEXT_BLOCK = "POLL_TRY_NEXT_BLOCK",
  POLL_NEVER = "POLL_NEVER",
  POLL_TRY_AT_BLOCK = "POLL_TRY_AT_BLOCK",
  POLL_TRY_AT_EPOCH = "POLL_TRY_AT_EPOCH",
}

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
const CUSTOM_ERROR_SELECTOR_MAP: Record<string, CustomErrorSelectors> = {};

export const abiToSelector = (abi: string): string =>
  ethers.utils.id(abi).slice(0, 10);

for (const errorType of Object.keys(
  CUSTOM_ERROR_ABI_MAP
) as CustomErrorSelectors[]) {
  const selector = abiToSelector(CUSTOM_ERROR_ABI_MAP[errorType]);
  CUSTOM_ERROR_SELECTOR_MAP[selector] = errorType;
}

/**
 * Attempts to verify that the contract at the given address implements the interface of the `ComposableCoW`
 * contract. This is done by checking that the contract contains the selectors of the functions that are
 * required to be implemented by the interface.
 *
 * @remarks This is not a foolproof way of verifying that the contract implements the interface, but it is
 * a good enough heuristic to filter out most of the contracts that do not implement the interface.
 *
 * @dev The selectors are:
 * - `cabinet(address,bytes32)`: `1c7662c8`
 * - `getTradeableOrderWithSignature(address,(address,bytes32,bytes),bytes,bytes32[])`: `26e0a196`
 *
 * @param code the contract's deployed bytecode as a hex string
 * @returns A boolean indicating if the contract likely implements the interface
 */
export function isComposableCowCompatible(code: string): boolean {
  const composableCow = ComposableCoW__factory.createInterface();

  return REQUIRED_SELECTORS.every((signature) => {
    const sighash = composableCow.getSighash(signature);
    return code.includes(sighash.slice(2));
  });
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

type ParsedCustomError = {
  selector: CustomErrorSelectors;
  message?: string;
  blockNumberOrEpoch?: number;
};

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and optionally a message.
 * @param revertData ABI-encoded custom error, which may or may not be parameterized.
 * @returns an empty parsed error if assumptions don't hold, otherwise the selector and message if applicable.
 */
export function parseCustomError(revertData: string): ParsedCustomError {
  try {
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
        const [message] = iface.decodeErrorResult(fragment, revertData);
        return { selector, message };
      case CustomErrorSelectors.POLL_TRY_AT_BLOCK:
      case CustomErrorSelectors.POLL_TRY_AT_EPOCH:
        const [blockNumberOrEpoch, msg] = iface.decodeErrorResult(
          fragment,
          revertData
        );

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
  } catch (err) {
    // This can only throw under the following conditions:
    // - The revert data is too short to contain a selector
    // - The revert data contains a selector that is not in the CUSTOM_ERROR_SELECTOR_MAP
    // - The revert data contains a selector that is in the CUSTOM_ERROR_SELECTOR_MAP, but the
    //   it's parameters are not ABI-encoded correctly (decode throws)
    throw err;
  }
}

export function handleOnChainCustomError(params: {
  owner: string;
  orderRef: string;
  chainId: SupportedChainId;
  target: string;
  callData: string;
  revertData: string;
}): PollResultErrors {
  const { owner, orderRef, chainId, target, callData, revertData } = params;
  const logPrefix = `contracts:handleOnChainCustomError:${orderRef}`;
  const log = getLogger(logPrefix);

  try {
    // The below will throw if:
    // - the error is not a custom error (ie. the selector is not in the map)
    // - the error is a custom error, but the parameters are not as expected
    const { selector, message, blockNumberOrEpoch } =
      parseCustomError(revertData);
    switch (selector) {
      case CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED:
      case CustomErrorSelectors.PROOF_NOT_AUTHED:
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
      case CustomErrorSelectors.INTERFACE_NOT_SUPPORTED:
        log.info(
          `${selector}: Order on safe ${owner} attempted to use a handler that is not supported. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `${selector}: The handler is not supported`,
        };
      case CustomErrorSelectors.INVALID_FALLBACK_HANDLER:
        log.info(
          `${selector}: Order for safe ${owner} where the Safe does not have ExtensibleFallbackHandler set. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `${selector}: The safe does not have ExtensibleFallbackHandler set`,
        };
      case CustomErrorSelectors.INVALID_HANDLER:
        log.info(
          `${selector}: Order type for safe ${owner}, failed IERC165 introspection check. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `${selector}: The safe does not have the handler set`,
        };
      case CustomErrorSelectors.SWAP_GUARD_RESTRICTED:
        log.info(
          `${selector}: Order for safe ${owner} where the Safe has swap guard enabled. Deleting order...`
        );
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `${selector}: The safe has swap guard enabled`,
        };
      // TODO: Add metrics to track this
      case CustomErrorSelectors.ORDER_NOT_VALID:
      case CustomErrorSelectors.POLL_TRY_NEXT_BLOCK:
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
      case CustomErrorSelectors.POLL_TRY_AT_BLOCK:
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
      case CustomErrorSelectors.POLL_TRY_AT_EPOCH:
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
      case CustomErrorSelectors.POLL_NEVER:
        // The conditional order has signalled that it should never be polled again.
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `PollNever: ${message}`,
        };
    }
  } catch (err) {
    // Any errors thrown here can _ONLY_ come from non-compliant interfaces (ie. bad revert ABI encoding).
    // We log the error, and return a DONT_TRY_AGAIN result.
    // TODO: Add metrics to track this
    log.debug(
      `Contract returned a non-interface compliant revert via getTradeableOrderWithSignature. Simulate: https://dashboard.tenderly.co/gp-v2/watch-tower-prod/simulator/new?network=${chainId}&contractAddress=${target}&rawFunctionInput=${callData}`
    );
    return {
      result: PollResultCode.DONT_TRY_AGAIN,
      reason: "Order returned a non-compliant (invalid/erroneous) revert hint",
    };
  }
}
