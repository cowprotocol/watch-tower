import {
  ORDER_BOOK_API_TIMEOUT_MS,
  escalatingRetryDelay,
  handleOrderBookError,
  postDiscreteOrder,
  checkForAndPlaceOrder,
} from ".";
import { ConditionalOrder, OrderStatus, Registry } from "../../types";
import { WATCHDOG_TIMEOUT_DEFAULT_SECS } from "../../services/chain";
import { initLogging, withTimeout } from "../../utils";
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

  const post = (
    sendOrder: jest.Mock,
    conditionalOrder: ConditionalOrder = { id: "0xid" } as ConditionalOrder
  ) =>
    postDiscreteOrder({
      conditionalOrder,
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

  // A promise that outlives its deadline, producing a real `TimeoutError`
  const timesOut = () =>
    jest.fn(() => withTimeout(new Promise(() => undefined), 1, "sendOrder"));

  it("backs off a timed-out post instead of reporting an unexpected error", async () => {
    const conditionalOrder = { id: "0xid" } as ConditionalOrder;

    const result = await post(timesOut(), conditionalOrder);

    expect(result.result).not.toBe(PollResultCode.UNEXPECTED_ERROR);
    expect(result).toMatchObject({ result: PollResultCode.TRY_NEXT_BLOCK });
    expect(conditionalOrder.consecutiveApiFailures).toBe(1);
  });

  it("escalates repeated timeouts onto the same backoff progression", async () => {
    const conditionalOrder = {
      id: "0xid",
      consecutiveApiFailures: 2,
    } as ConditionalOrder;

    const result = await post(timesOut(), conditionalOrder);

    expect(result).toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: 1_784_857_003 + 60,
    });
    expect(conditionalOrder.consecutiveApiFailures).toBe(3);
  });

  it("reports why a non-response failure happened instead of 'undefined'", async () => {
    const sendOrder = jest.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await post(sendOrder);

    expect(result).toMatchObject({ result: PollResultCode.UNEXPECTED_ERROR });
    expect((result as { reason: string }).reason).toContain("socket hang up");
  });
});

describe("checkForAndPlaceOrder chunked writes", () => {
  const NOW_EPOCH = 1_784_857_003;
  const expiredUid = (i: number) =>
    "0x" +
    i.toString(16).padStart(64, "0") +
    "bb".repeat(20) +
    (NOW_EPOCH - 600).toString(16).padStart(8, "0");

  // More than CHUNK_SIZE (50) so the chunked write at updatedCount === 51 fires
  const ORDER_COUNT = 60;

  const buildRegistry = (persisted: string[]) => {
    const orders = Array.from({ length: ORDER_COUNT }, (_, i) => ({
      id: `0x${i}`,
      tx: "0xtx",
      params: { handler: "0xhandler", salt: "0xsalt", staticInput: "0x" },
      proof: null,
      orders: new Map([[expiredUid(i), OrderStatus.SUBMITTED]]),
      composableCow: "0xccow",
    })) as unknown as ConditionalOrder[];

    const batch: { put: jest.Mock; del: jest.Mock; write: jest.Mock } = {
      put: jest.fn((key: string, value: string) => {
        if (String(key) === "CONDITIONAL_ORDER_REGISTRY_8453") {
          persisted.push(value);
        }
        return batch;
      }),
      del: jest.fn(() => batch),
      write: jest.fn(async () => undefined),
    };

    return new Registry(
      new Map([["0xowner", new Set(orders)]]) as never,
      { getDB: () => ({ batch: () => batch }) } as never,
      "8453",
      null,
      { number: 1, timestamp: NOW_EPOCH, hash: "0x0" }
    );
  };

  it("excludes expired uids from the first persisted registry", async () => {
    const persisted: string[] = [];
    const registry = buildRegistry(persisted);

    const context = {
      chainId: 8453,
      registry,
      filterPolicy: undefined,
      provider: { _isProvider: true },
      orderBookApi: {},
      dryRun: true,
      contract: {},
      multicall: {},
    } as never;

    await checkForAndPlaceOrder(context, {
      number: 1,
      timestamp: NOW_EPOCH,
    } as never).catch(() => undefined);

    expect(persisted.length).toBeGreaterThan(1);
    expect(persisted[0]).not.toContain(expiredUid(0));
  });
});
