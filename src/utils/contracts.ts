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

// These are the `sighash` of the custom errors, with sighashes being calculated the same way for custom
// errors as they are for functions in solidity.
export const ORDER_NOT_VALID_SELECTOR = "0xc8fc2725";
export const SINGLE_ORDER_NOT_AUTHED_SELECTOR = "0x7a933234";
export const PROOF_NOT_AUTHED_SELECTOR = "0x4a821464";

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
  errorNameOrSelector?: string;
  message?: string;
};

/**
 * Given a raw ABI-encoded custom error returned from a revert, extract the selector and optionally a message.
 * @param abi of the custom error, which may or may not be parameterised.
 * @returns an empty parsed error if assumptions don't hold, otherwise the selector and message if applicable.
 */
const rawErrorDecode = (abi: string): ParsedError => {
  if (abi.length === 10) {
    return { errorNameOrSelector: abi };
  } else {
    try {
      const selector = abi.slice(0, 10);
      const message = ethers.utils.defaultAbiCoder.decode(
        ["string"],
        "0x" + abi.slice(10) // trim off the selector
      )[0];
      return { errorNameOrSelector: selector, message };
    } catch {
      // some weird parameter, just return and let the caller deal with it
      return {};
    }
  }
};

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
export const parseCustomError = (error: any): ParsedError => {
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
    return rawErrorDecode(data);
  } else {
    // This is a Nethermind node, as `data` *must* be equal to `0x`, but we know we always revert with an
    // message, so - we have to go digging ⛏️🙄
    //
    // Verify our assumption that `error.error.error.data` is defined and is a string.
    const rawNethermind = error?.error?.error?.data;
    if (typeof rawNethermind === "string") {
      // For some reason, Nethermind pad their message with `Reverted `, so, we need to slice off the
      // extraneous part of the message, and just get the data - that we wanted in the first place!
      const nethermindData = rawNethermind.slice("Reverted ".length);
      return rawErrorDecode(nethermindData);
    } else {
      // the nested error-ception for some reason failed and our assumptions are therefore incorrect.
      // return the unknown state to the caller.
      return {};
    }
  }
};
