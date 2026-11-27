import {
  OrderBookApiError,
  OrderCreation,
  OrderKind,
  OrderPostError,
  OrderStatus,
  SigningScheme,
} from "@cowprotocol/sdk-order-book";
import { PollResultCode } from "@cowprotocol/sdk-composable";

import type { ChainContext } from "../../services";
import type { AaveOrderAttempt, ConditionalOrder } from "../../types";
import { TimeoutError } from "../../utils";
import {
  pollTrackedOrder,
  retryAfterEpoch,
  submitOrder,
} from "./aaveOrderAttempt";

const payload: OrderCreation = {
  sellToken: "0x" + "11".repeat(20),
  buyToken: "0x" + "22".repeat(20),
  sellAmount: "10",
  buyAmount: "20",
  validTo: 1_795_433_300,
  appData: "{}",
  feeAmount: "0",
  kind: OrderKind.SELL,
  partiallyFillable: false,
  signingScheme: SigningScheme.EIP1271,
  signature: "0x1234",
};
const { validTo } = payload;
const blockTime = validTo - 120;
const timeout = new TimeoutError("Aave sendOrder", 1);
const nextBlock = { result: PollResultCode.TRY_NEXT_BLOCK };
const stopPolling = { result: PollResultCode.DONT_TRY_AGAIN };
const at = (epoch: number) => ({ result: PollResultCode.TRY_AT_EPOCH, epoch });

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(blockTime * 1000);
});

afterEach(() => jest.restoreAllMocks());

function apiError(status: number, errorType?: string, retryAfter?: string) {
  return new OrderBookApiError(
    new Response(null, {
      status,
      headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
    }),
    { errorType }
  );
}

function fixture() {
  const uid = "0x" + "aa".repeat(56);
  const attempt: AaveOrderAttempt = { uid, validTo, state: "pending", payload };
  const rule = {} as ConditionalOrder;
  const write = jest.fn().mockResolvedValue(undefined);
  const sendOrder = jest.fn().mockResolvedValue(uid);
  const getOrder = jest
    .fn()
    .mockResolvedValue({ uid, status: OrderStatus.OPEN });
  const context = {
    registry: { write },
    orderBookApi: { sendOrder, getOrder },
  } as unknown as ChainContext;
  const submit = (deadline?: number) =>
    submitOrder(context, rule, attempt, blockTime, undefined, deadline);
  const poll = (
    time = blockTime,
    canResend = async () => true,
    deadline?: number
  ) => pollTrackedOrder(context, attempt, time, canResend, undefined, deadline);
  return { attempt, rule, write, sendOrder, getOrder, submit, poll };
}

it("only repeats the saved POST after lookup returns 404 and the rule is eligible", async () => {
  const { write, sendOrder, getOrder, submit, poll, attempt } = fixture();
  sendOrder.mockRejectedValueOnce(timeout);

  expect(await submit()).toMatchObject(nextBlock);
  expect(write.mock.invocationCallOrder[0]).toBeLessThan(
    sendOrder.mock.invocationCallOrder[0]
  );
  expect(attempt.payload).toEqual(payload);

  getOrder.mockRejectedValue(apiError(404));
  await poll(blockTime, async () => false);
  expect(sendOrder).toHaveBeenCalledTimes(1);

  expect(await poll(blockTime + 12)).toMatchObject(at(validTo));
  expect(getOrder.mock.calls.map(([uid]) => uid)).toEqual([
    attempt.uid,
    attempt.uid,
  ]);
  expect(getOrder.mock.invocationCallOrder[1]).toBeLessThan(
    sendOrder.mock.invocationCallOrder[1]
  );
  expect(sendOrder.mock.calls).toEqual([
    sendOrder.mock.calls[0],
    sendOrder.mock.calls[0],
  ]);
  expect(write).toHaveBeenCalledTimes(1);
});

it("keeps an order already accepted by the orderbook after a lost response", async () => {
  const { attempt, sendOrder, getOrder, submit, poll } = fixture();
  const canResend = jest.fn();
  sendOrder.mockRejectedValueOnce(timeout);
  await submit();

  expect(await poll(blockTime, canResend)).toMatchObject(at(validTo));
  expect(getOrder.mock.calls[0][0]).toBe(attempt.uid);
  expect(sendOrder).toHaveBeenCalledTimes(1);
  expect(canResend).not.toHaveBeenCalled();
  expect(attempt).toMatchObject({ state: "accepted" });
  expect(attempt.payload).toBeUndefined();
});

it("never posts when the payload cannot be saved", async () => {
  const { rule, write, sendOrder, submit } = fixture();
  write.mockRejectedValueOnce(new Error("DB unavailable"));

  await expect(submit()).rejects.toThrow("DB unavailable");
  expect(sendOrder).not.toHaveBeenCalled();
  expect(rule.aaveOrderAttempt).toBeUndefined();
});

it.each([
  ["polling budget", 30, 10],
  ["order validity", 65, 100],
])(
  "checks the %s again after saving before the first POST",
  async (_reason, elapsed, budget) => {
    const { rule, write, sendOrder, submit } = fixture();
    write.mockImplementationOnce(async () => {
      jest.spyOn(Date, "now").mockReturnValue((blockTime + elapsed) * 1000);
    });

    expect(await submit(Date.now() + budget * 1000)).toMatchObject(nextBlock);
    expect(sendOrder).not.toHaveBeenCalled();
    expect(rule.aaveOrderAttempt).toBeUndefined();
  }
);

it("allows a fresh quote after the first POST is definitively rejected as stale", async () => {
  const { rule, sendOrder, submit } = fixture();
  sendOrder.mockRejectedValueOnce(
    apiError(400, OrderPostError.errorType.QUOTE_NOT_FOUND)
  );

  expect(await submit()).toMatchObject(at(blockTime + 30));
  expect(rule.aaveOrderAttempt).toBeUndefined();
});

it.each(["a mismatched response", "a rejected resend"])(
  "only looks up the original UID after %s",
  async (cause) => {
    const { attempt, write, sendOrder, getOrder, submit, poll } = fixture();
    getOrder.mockRejectedValue(apiError(404));
    if (cause === "a mismatched response") {
      sendOrder.mockResolvedValueOnce("0x" + "bb".repeat(56));
      await submit();
    } else {
      sendOrder
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(
          apiError(400, OrderPostError.errorType.QUOTE_NOT_FOUND)
        );
      await submit();
      await poll();
      expect(write).toHaveBeenCalledTimes(2); // The lookup-only state is durable.
    }
    expect(attempt).toMatchObject({ state: "lookup-only" });
    expect(attempt.payload).toBeUndefined();

    const canResend = jest.fn();
    await poll(blockTime, canResend);
    expect(canResend).not.toHaveBeenCalled();
    expect(sendOrder).toHaveBeenCalledTimes(
      cause === "a mismatched response" ? 1 : 2
    );
    expect(getOrder.mock.calls[getOrder.mock.calls.length - 1][0]).toBe(
      attempt.uid
    );
  }
);

it("honors cooldowns on POST and GET without generating another UID", async () => {
  const { attempt, sendOrder, getOrder, submit, poll } = fixture();
  sendOrder.mockRejectedValueOnce(apiError(429, undefined, "70"));
  expect(await submit()).toMatchObject(at(blockTime + 70));

  getOrder.mockRejectedValueOnce(
    apiError(429, undefined, new Date((blockTime + 110) * 1000).toUTCString())
  );
  expect(await poll(blockTime + 70)).toMatchObject(at(blockTime + 110));
  expect(attempt.payload).toEqual(payload);
  expect(sendOrder).toHaveBeenCalledTimes(1);
});

it("handles invalid cooldowns and caps valid ones at the lookup deadline", () => {
  expect(retryAfterEpoch(apiError(429, undefined, "-1"), blockTime)).toBe(
    blockTime + 30
  );
  expect(
    retryAfterEpoch(apiError(429, undefined, "99999"), blockTime, validTo)
  ).toBe(validTo);
});

it("tracks late fills through the expiry grace period without resending", async () => {
  const { attempt, sendOrder, getOrder, submit, poll } = fixture();
  await submit();
  getOrder
    .mockRejectedValueOnce(apiError(404))
    .mockResolvedValueOnce({ uid: attempt.uid, status: OrderStatus.EXPIRED })
    .mockResolvedValueOnce({ uid: attempt.uid, status: OrderStatus.FULFILLED });

  expect(await poll(validTo)).toMatchObject(nextBlock);
  expect(await poll(validTo + 12)).toMatchObject(nextBlock);
  expect(await poll(validTo + 24)).toMatchObject({
    ...stopPolling,
    reason: `Aave protection order ${attempt.uid} ${OrderStatus.FULFILLED}`,
  });
  expect(await poll(validTo + 30)).toMatchObject(stopPolling);
  expect(getOrder).toHaveBeenCalledTimes(3);
  expect(sendOrder).toHaveBeenCalledTimes(1);
});
