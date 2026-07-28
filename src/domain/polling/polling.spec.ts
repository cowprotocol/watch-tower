import {
  ORDER_BOOK_API_TIMEOUT_MS,
  escalatingRetryDelay,
  handleOrderBookError,
  postDiscreteOrder,
} from ".";
import { WATCHDOG_TIMEOUT_DEFAULT_SECS } from "../../services/chain";
import { initLogging } from "../../utils";
import { PollResultCode } from "@cowprotocol/sdk-composable";

describe("escalatingRetryDelay", () => {
  it("retries on the next block for the first two failures", () => {
    expect(escalatingRetryDelay(1)).toBeUndefined();
    expect(escalatingRetryDelay(2)).toBeUndefined();
  });

  it("backs off for a minute on the third consecutive failure", () => {
    expect(escalatingRetryDelay(3)).toBe(60);
  });

  it("backs off for ten minutes on the fourth consecutive failure", () => {
    expect(escalatingRetryDelay(4)).toBe(600);
  });

  it("settles on an hourly retry once the order is clearly broken", () => {
    expect(escalatingRetryDelay(5)).toBe(3600);
    expect(escalatingRetryDelay(99)).toBe(3600);
  });
});

describe("handleOrderBookError", () => {
  const NOW = 1_784_857_003;
  const LABELS = ["8453", "0xhandler", "0xowner", "0xid"];
  const invalidSignature = {
    errorType: "InvalidEip1271Signature",
    description: "signature for computed order has bad format",
  };

  const handle = (consecutiveFailures: number) =>
    handleOrderBookError(
      400,
      invalidSignature,
      new Error("api"),
      NOW,
      LABELS,
      consecutiveFailures
    );

  it("retries on the next block while the failure may still be transient", () => {
    expect(handle(1)).toMatchObject({
      result: PollResultCode.TRY_NEXT_BLOCK,
    });
  });

  it("backs off once the same failure keeps repeating", () => {
    expect(handle(3)).toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: NOW + 60,
    });
  });

  it("escalates to an hourly retry for a persistently broken order", () => {
    expect(handle(9)).toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: NOW + 3600,
    });
  });
});

describe("ORDER_BOOK_API_TIMEOUT_MS", () => {
  it("bounds a single orderbook call below the default watchdog deadline", () => {
    expect(ORDER_BOOK_API_TIMEOUT_MS).toBeLessThan(
      WATCHDOG_TIMEOUT_DEFAULT_SECS * 1000
    );
  });
});

describe("postDiscreteOrder", () => {
  initLogging({});

  const post = (sendOrder: jest.Mock) =>
    postDiscreteOrder({
      conditionalOrder: { id: "0xid" } as never,
      orderUid: "0xuid",
      order: {
        kind: "sell",
        sellAmount: 1n,
        buyAmount: 1n,
        feeAmount: 0n,
        validTo: 0,
      },
      orderBookApi: { sendOrder } as never,
      blockTimestamp: 1_784_857_003,
      dryRun: false,
      metricLabels: ["8453", "0xhandler", "0xowner", "0xid"],
      chainId: 8453 as never,
      blockNumber: 1,
      ownerNumber: 1,
      orderNumber: 1,
    });

  it("reports why a non-response failure happened instead of 'undefined'", async () => {
    const sendOrder = jest.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await post(sendOrder);

    expect(result).toMatchObject({ result: PollResultCode.UNEXPECTED_ERROR });
    expect((result as { reason: string }).reason).toContain("socket hang up");
  });
});
