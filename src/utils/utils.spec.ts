import { describe, it } from "node:test";
import assert from "node:assert";

import {
  CUSTOM_ERROR_ABI_MAP,
  CustomErrorSelectors,
  abiToSelector,
  handleOnChainCustomError,
  initLogging,
  parseCustomError,
} from ".";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";

const chainIds = Object.keys(SupportedChainId)
  .map((chainId) => Number(chainId))
  .filter((chainId) => !isNaN(chainId));

describe("parse custom errors (reversions)", () => {
  it("should pass the SingleOrderNotAuthed selector correctly", () => {
    assert.partialDeepStrictEqual(
      parseCustomError(SINGLE_ORDER_NOT_AUTHED_ERROR),
      {
        selector: "SINGLE_ORDER_NOT_AUTHED",
      },
    );
  });

  it("should pass the OrderNotValid selector correctly", () => {
    assert.partialDeepStrictEqual(parseCustomError(ORDER_NOT_VALID), {
      selector: "ORDER_NOT_VALID",
      message: "after twap finish",
    });
  });

  it("should pass the PollTryNextBlock selector correctly", () => {
    assert.partialDeepStrictEqual(parseCustomError(POLL_TRY_NEXT_BLOCK), {
      selector: "POLL_TRY_NEXT_BLOCK",
      message: "try me again",
    });
  });

  it("should pass the PollTryAtBlock selector correctly", () => {
    assert.partialDeepStrictEqual(parseCustomError(POLL_TRY_AT_BLOCK), {
      selector: "POLL_TRY_AT_BLOCK",
      message: "red pill",
      blockNumberOrEpoch: 303,
    });
  });

  it("should pass the PollTryAtEpoch selector correctly", () => {
    assert.partialDeepStrictEqual(parseCustomError(POLL_TRY_AT_EPOCH), {
      selector: "POLL_TRY_AT_EPOCH",
      message: "here's looking at you",
      blockNumberOrEpoch: 1694340000,
    });
  });

  it("should pass the PollNever selector correctly", () => {
    assert.partialDeepStrictEqual(parseCustomError(POLL_NEVER), {
      selector: "POLL_NEVER",
      message: "after twap finish",
    });
  });
});

describe("handle on-chain custom errors", () => {
  initLogging({});
  const happyPath = {
    owner: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    target: COMPOSABLE_COW_CONTRACT_ADDRESS[1],
    callData: "0xca1fca1fca1fca1f",
    orderRef: "orderRefForLogging",
    chainId: 1,
    revertData: abiToSelector(
      CUSTOM_ERROR_ABI_MAP[CustomErrorSelectors.SINGLE_ORDER_NOT_AUTHED],
    ),
    metricLabels: ["chain_id", "handler", "owner", "id"],
    blockNumber: 123456,
    ownerNumber: 2,
    orderNumber: 3,
  };

  const getHappyPathWithChainId = (chainId: number) => {
    return {
      ...happyPath,
      chainId,
    };
  };

  chainIds.forEach((chainId) => {
    it(`should pass a known selector correctly for chainId ${chainId}`, () => {
      assert.partialDeepStrictEqual(
        handleOnChainCustomError(getHappyPathWithChainId(chainId)),
        {
          reason:
            "SINGLE_ORDER_NOT_AUTHED: The owner has not authorized the order",
          result: "DONT_TRY_AGAIN",
        },
      );
    });
  });

  chainIds.forEach((chainId) => {
    it(`should drop if the revert selector does not exist in the map for chainId ${chainId}`, () => {
      const unknownSelector = "0xdeadbeef";
      assert.partialDeepStrictEqual(
        handleOnChainCustomError({
          ...getHappyPathWithChainId(chainId),
          revertData: unknownSelector,
        }),
        {
          reason:
            "Order returned a non-compliant (invalid/erroneous) revert hint",
          result: "DONT_TRY_AGAIN",
        },
      );
    });
  });

  chainIds.forEach((chainId) => {
    it(`should drop if the revert data is too short even to be a selector for chainId ${chainId}`, () => {
      const shortReverts = ["0x", "0xca1f"];
      shortReverts.forEach((shortRevert) =>
        assert.partialDeepStrictEqual(
          handleOnChainCustomError({
            ...getHappyPathWithChainId(chainId),
            revertData: shortRevert,
          }),
          {
            reason:
              "Order returned a non-compliant (invalid/erroneous) revert hint",
            result: "DONT_TRY_AGAIN",
          },
        ),
      );
    });
  });

  chainIds.forEach((chainId) => {
    it(`should drop if the revert data has not been encoded correctly for chainId ${chainId}`, () => {
      assert.partialDeepStrictEqual(
        handleOnChainCustomError({
          ...getHappyPathWithChainId(chainId),
          revertData: POLL_TRY_AT_EPOCH_INVALID,
        }),
        {
          reason:
            "Order returned a non-compliant (invalid/erroneous) revert hint",
          result: "DONT_TRY_AGAIN",
        },
      );
    });
  });
});

// test data

const SINGLE_ORDER_NOT_AUTHED_ERROR = "0x7a933234";

const ORDER_NOT_VALID =
  "0xc8fc272500000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000011616674657220747761702066696e697368000000000000000000000000000000";

const POLL_TRY_NEXT_BLOCK =
  "0xd05f30650000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c747279206d6520616761696e0000000000000000000000000000000000000000";

const POLL_TRY_AT_BLOCK =
  "0x1fe8506e000000000000000000000000000000000000000000000000000000000000012f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000087265642070696c6c000000000000000000000000000000000000000000000000";

const POLL_TRY_AT_EPOCH =
  "0x7e3346370000000000000000000000000000000000000000000000000000000064fd93a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000015686572652773206c6f6f6b696e6720617420796f750000000000000000000000";

const POLL_TRY_AT_EPOCH_INVALID =
  "0x7e33463700000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000064fd93a00000000000000000000000000000000000000000000000000000000000000015686572652773206c6f6f6b696e6720617420796f750000000000000000000000";

const POLL_NEVER =
  "0x981b64cd00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000011616674657220747761702066696e697368000000000000000000000000000000";
