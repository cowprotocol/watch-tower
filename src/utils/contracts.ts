import { ethers } from "ethers";
import { ComposableCoW, ComposableCoW__factory } from "../types";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";

// Selectors that are required to be part of the contract's bytecode in order to be considered compatible
const REQUIRED_SELECTORS = [
  "cabinet(address,bytes32)",
  "getTradeableOrderWithSignature(address,(address,bytes32,bytes),bytes,bytes32[])",
];

const CUSTOM_ERROR_ABI_MAP = {
  PROOF_NOT_AUTHED: "ProofNotAuthed()",
  SINGLE_ORDER_NOT_AUTHED: "SingleOrderNotAuthed()",
  SWAP_GUARD_RESTRICTED: "SwapGuardRestricted()",
  INVALID_HANDLER: "InvalidHandler()",
  INVALID_FALLBACK_HANDLER: "InvalidFallbackHandler()",
  INTERFACE_NOT_SUPPORTED: "InterfaceNotSupported()",
  ORDER_NOT_VALID: "OrderNotValid(string)",
  POLL_TRY_NEXT_BLOCK: "PollTryNextBlock(string)",
  POLL_NEVER: "PollNever(string)",
  POLL_TRY_AT_BLOCK: "PollTryAtBlock(uint256,string)",
  POLL_TRY_AT_EPOCH: "PollTryAtEpoch(uint256,string)",
};

// Just export the keys of the CUSTOM_ERROR_ABI_MAP as a type
export type CustomError = keyof typeof CUSTOM_ERROR_ABI_MAP;

// To be able to do fast lookup of the selector given the id, we need to reverse the map
// This should be a one-time operation, and cached for future use
const CUSTOM_ERROR_ID_TO_NAME_MAP = Object.entries(CUSTOM_ERROR_ABI_MAP).reduce(
  (acc, [name, selector]) => {
    acc[ethers.utils.id(selector).slice(0, 10)] = name as CustomError;
    return acc;
  },
  {} as Record<string, CustomError>
);

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

type ParsedError = {
  selector: string;
  message?: string;
  blockNumberOrEpoch?: number;
};

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and optionally a message.
 * @param errorData ABI-encoded custom error, which may or may not be parameterized.
 * @returns an empty parsed error if assumptions don't hold, otherwise the selector and message if applicable.
 */
export function customErrorDecode(errorData: string): ParsedError {
  // only proceed if the return data is at least 10 bytes long
  if (errorData.length >= 10) {
    const rawSelector = errorData.slice(0, 10);
    // if the raw selector is not in the map, break early
    if (!(rawSelector in CUSTOM_ERROR_ID_TO_NAME_MAP)) {
      return { selector: rawSelector, message: `Unknown error: ${errorData}` };
    }

    const selector = CUSTOM_ERROR_ID_TO_NAME_MAP[errorData.slice(0, 10)];
    try {
      switch (selector) {
        case "PROOF_NOT_AUTHED":
        case "SINGLE_ORDER_NOT_AUTHED":
        case "INTERFACE_NOT_SUPPORTED":
        case "INVALID_FALLBACK_HANDLER":
        case "INVALID_HANDLER":
        case "SWAP_GUARD_RESTRICTED":
          return { selector };
        case "ORDER_NOT_VALID":
        case "POLL_TRY_NEXT_BLOCK":
        case "POLL_NEVER":
          const message = ethers.utils.defaultAbiCoder.decode(
            ["string"],
            "0x" + errorData.slice(10) // trim off the selector
          )[0];
          return { selector, message };
        case "POLL_TRY_AT_BLOCK":
        case "POLL_TRY_AT_EPOCH":
          const [blockNumberOrEpoch, msg] = ethers.utils.defaultAbiCoder.decode(
            ["uint256", "string"],
            "0x" + errorData.slice(10) // trim off the selector
          );
          return {
            selector,
            message: msg,
            blockNumberOrEpoch: blockNumberOrEpoch.toNumber(),
          };
      }
    } catch (err) {
      // This can only return an error if the ABI decoding fails, which should never happen
      // except for a bug in the smart contract code or the ABI encoding. In this case, we
      // just bubble up the error.
      throw err;
    }
  }

  // If we get here, we have a selector that is not in the map, or the return data is too short
  throw new Error(`Invalid error data: ${errorData}`);
}
