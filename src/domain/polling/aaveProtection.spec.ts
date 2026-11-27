import {
  OrderBalance,
  OrderKind,
  computeOrderUid,
} from "@cowprotocol/contracts";
import { setGlobalAdapter } from "@cowprotocol/cow-sdk";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import {
  OrderBookApiError,
  OrderStatus as ApiOrderStatus,
} from "@cowprotocol/sdk-order-book";
import { ethers } from "ethers";
import { Level } from "level";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkForAndPlaceOrder } from ".";
import type { ChainContext, DBService } from "../../services";
import {
  AavePositionProtector__factory,
  ComposableCoW__factory,
  ConditionalOrderCreatedEvent,
  Registry,
} from "../../types";
import { TimeoutError, initLogging } from "../../utils";
import * as quoting from "../aaveProtectionQuote";
import { processNewOrderEvent } from "../events";

initLogging({ logLevel: "ERROR" });

const { hexZeroPad, id, parseEther } = ethers.utils;
const composableCow = hexZeroPad("0x01", 20);
const protector = hexZeroPad("0x02", 20);
const handler = hexZeroPad("0x03", 20);
const borrower = hexZeroPad("0x04", 20);
const pool = hexZeroPad("0x05", 20);
const sellToken = hexZeroPad("0x06", 20);
const buyToken = hexZeroPad("0x07", 20);
const now = 1_795_433_000;
const expiry = now + 250;
const ruleId = id("protection rule");
// The quote tests cover the flash-loan document. Here it must pass through unchanged.
const appDataSuffix = '}},"version":"1.5.0"}';
const appData = `{"metadata":{"utm":{"utmContent":"aave-rule-${ruleId}"${appDataSuffix}`;
const order = {
  sellToken,
  buyToken,
  receiver: protector,
  sellAmount: parseEther("0.03").toString(),
  buyAmount: "29700000",
  validTo: expiry,
  appData: id(appData),
  feeAmount: "0",
  kind: OrderKind.SELL,
  partiallyFillable: false,
  buyTokenBalance: OrderBalance.ERC20,
  sellTokenBalance: OrderBalance.ERC20,
} as const;
const signature = "0x1234";
const signedOrder = {
  ...order,
  kind: id(order.kind),
  sellTokenBalance: id(order.sellTokenBalance),
  buyTokenBalance: id(order.buyTokenBalance),
};
const params = {
  handler,
  salt: ethers.constants.HashZero,
  staticInput: ruleId,
};
const protectorAbi = AavePositionProtector__factory.createInterface();
const cowAbi = ComposableCoW__factory.createInterface();
const orderDomain = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: 1,
  verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
};
const uid = computeOrderUid(orderDomain, order, protector);
const quotedOrder = {
  order,
  appData,
  appDataSuffix,
  quoteId: 42,
  estimatedCollateralDebit: parseEther("0.03002").toBigInt(),
  projectedHealthFactor: parseEther("1.201").toBigInt(),
};

let database: Level<string, string> | undefined;
let databaseDir: string | undefined;

async function fixture(dryRun = false) {
  const clock = jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  const provider = new ethers.providers.StaticJsonRpcProvider(undefined, 1);
  setGlobalAdapter(new EthersV5Adapter({ provider }));
  const market = { active: true, ruleExpiry: expiry, registered: true };
  const read = jest
    .spyOn(provider, "call")
    .mockImplementation(async () =>
      protectorAbi.encodeFunctionResult("quoteInputs", [
        [
          market.registered ? borrower : ethers.constants.AddressZero,
          [
            sellToken,
            buyToken,
            parseEther("1.10"),
            parseEther("1.20"),
            parseEther("0.12"),
            market.ruleExpiry,
            300,
          ],
          parseEther(market.active ? "1.10" : "1.11"),
          parseEther("0.12"),
          market.active ? pool : ethers.constants.AddressZero,
          parseEther("0.12"),
          92000000,
          8400,
          5,
          100000000000,
          100000000,
          18,
          6,
          2,
        ],
      ])
    );
  const quote = jest
    .spyOn(quoting, "quoteAaveProtection")
    .mockResolvedValue(quotedOrder);
  const sign = jest.fn().mockResolvedValue({ order: signedOrder, signature });
  const sendOrder = jest.fn().mockResolvedValue(uid);
  const getOrder = jest.fn().mockResolvedValue({
    uid,
    status: ApiOrderStatus.OPEN,
  });
  databaseDir = await mkdtemp(join(tmpdir(), "aave-polling-"));
  database = new Level(databaseDir, { valueEncoding: "json" });
  const storage = { getDB: () => database } as unknown as DBService;
  const registry = new Registry(new Map(), storage, "1", null, null);
  const context = {
    chainId: 1,
    aaveProtectionHandler: handler,
    addresses: [protector],
    watchdogTimeout: 60,
    dryRun,
    registry,
    provider,
    orderBookApi: { getOrder, sendOrder },
    contract: {
      address: composableCow,
      interface: cowAbi,
      getTradeableOrderWithSignature: sign,
    },
  } as unknown as ChainContext;
  const event = cowAbi.encodeEventLog(
    cowAbi.getEvent("ConditionalOrderCreated"),
    [protector, params]
  );
  await processNewOrderEvent(context, {
    ...event,
    address: composableCow,
    transactionHash: id("registration"),
    blockNumber: 100,
  } as ConditionalOrderCreatedEvent);

  const poll = (offset = 0, timestamp = now + 12 * offset) => {
    clock.mockReturnValue(timestamp * 1000);
    return checkForAndPlaceOrder(context, {
      number: 100 + offset,
      timestamp,
    } as ethers.providers.Block);
  };
  return {
    clock,
    context,
    getOrder,
    market,
    quote,
    get attempt() {
      return [...(context.registry.ownerOrders.get(protector) ?? [])][0]
        ?.aaveOrderAttempt;
    },
    restart: async () =>
      Object.assign(context, {
        dryRun: false,
        registry: await Registry.load(storage, "1", 100),
      }),
    read,
    sendOrder,
    sign,
    poll,
  };
}

afterEach(async () => {
  jest.restoreAllMocks();
  if (database) await database.close();
  if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  database = undefined;
  databaseDir = undefined;
});

it("discovers the rule, waits above its trigger and submits one signed order", async () => {
  const demo = await fixture();
  expect(demo.context.registry.numOrders).toBe(1);
  demo.market.active = false;
  await demo.poll();
  expect(demo.quote).not.toHaveBeenCalled();

  demo.market.active = true;
  await demo.poll(1);
  await demo.poll(2);
  expect(demo.quote).toHaveBeenCalledTimes(1);
  expect(demo.read).toHaveBeenLastCalledWith(
    expect.objectContaining({
      to: protector,
      data: protectorAbi.encodeFunctionData("quoteInputs", [ruleId]),
    }),
    101
  );
  expect(demo.sign).toHaveBeenCalledWith(
    protector,
    params,
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 sellAmount,uint256 buyAmount,string appDataSuffix,uint32 validTo)",
      ],
      [[order.sellAmount, order.buyAmount, appDataSuffix, expiry]]
    ),
    [],
    { blockTag: 101 }
  );
  expect(demo.sendOrder).toHaveBeenCalledTimes(1);
  expect(demo.sendOrder.mock.calls[0][0]).toMatchObject({
    from: protector,
    receiver: protector,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    validTo: expiry,
    signature,
    appData,
    appDataHash: order.appData,
  });
  expect(demo.context.registry.numOrders).toBe(1);
  expect(demo.attempt).toMatchObject({ state: "accepted", uid });
  demo.getOrder.mockResolvedValueOnce({
    uid,
    status: ApiOrderStatus.FULFILLED,
  });
  await demo.poll(21);
  expect(demo.getOrder).toHaveBeenCalledTimes(1);
  expect(demo.context.registry.numOrders).toBe(0);
  expect(demo.sendOrder).toHaveBeenCalledTimes(1);
});

it("does not submit when the signed order differs from the quote", async () => {
  const demo = await fixture();
  demo.sign.mockResolvedValueOnce({
    order: { ...signedOrder, buyTokenBalance: id("internal") },
    signature,
  });
  await demo.poll();
  expect(demo.sign).toHaveBeenCalledTimes(1);
  expect(demo.sendOrder).not.toHaveBeenCalled();
});

it("loads an uncertain attempt and retries the same UID and payload", async () => {
  const demo = await fixture();
  demo.sendOrder.mockRejectedValueOnce(new TimeoutError("Aave POST", 1));
  await demo.poll();
  const originalPayload = demo.sendOrder.mock.calls[0][0];
  await demo.restart();
  expect(demo.attempt?.uid).toBe(uid);
  demo.getOrder.mockRejectedValueOnce(
    new OrderBookApiError(new Response(null, { status: 404 }), {})
  );
  await demo.poll(1);
  expect(demo.getOrder.mock.calls[0][0]).toBe(uid);
  expect(demo.sendOrder.mock.calls.map(([payload]) => payload)).toEqual([
    originalPayload,
    originalPayload,
  ]);
  expect(demo.quote).toHaveBeenCalledTimes(1);
  expect(demo.sign).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "checks the standing rule before replacing an expired attempt (registered: %s)",
  async (registered) => {
    const demo = await fixture();
    demo.market.ruleExpiry = 0;
    const firstValidTo = now + quoting.AAVE_ORDER_VALIDITY_SECONDS;
    const mockOrder = (validTo: number) => {
      const terms = { ...order, validTo };
      demo.quote.mockResolvedValueOnce({ ...quotedOrder, order: terms });
      demo.sign.mockResolvedValueOnce({
        order: { ...signedOrder, validTo },
        signature,
      });
      demo.sendOrder.mockResolvedValueOnce(
        computeOrderUid(orderDomain, terms, protector)
      );
    };
    mockOrder(firstValidTo);
    await demo.poll();
    const oldUid = demo.attempt?.uid;
    if (!oldUid) throw new Error("Missing initial attempt");

    demo.getOrder.mockResolvedValueOnce({
      uid: oldUid,
      status: ApiOrderStatus.CANCELLED,
    });
    await demo.poll(1, firstValidTo);
    expect(demo.attempt?.uid).toBe(oldUid);
    expect(demo.sendOrder).toHaveBeenCalledTimes(1);

    demo.market.registered = registered;
    await demo.poll(2, firstValidTo + 31);
    expect(demo.attempt).toBeUndefined();
    expect(demo.context.registry.numOrders).toBe(registered ? 1 : 0);

    if (registered) {
      const nextPoll = firstValidTo + 32;
      mockOrder(nextPoll + quoting.AAVE_ORDER_VALIDITY_SECONDS);
      await demo.poll(3, nextPoll);
      expect(demo.attempt?.uid).toEqual(expect.any(String));
      expect(demo.attempt?.uid).not.toBe(oldUid);
    }
    expect(demo.sendOrder).toHaveBeenCalledTimes(registered ? 2 : 1);
  }
);

it("previews without saving an attempt or delaying a live restart", async () => {
  const demo = await fixture(true);
  await demo.poll();
  await demo.poll(1);
  expect(demo.sign).toHaveBeenCalledTimes(1);
  expect(demo.sendOrder).not.toHaveBeenCalled();
  expect(demo.attempt).toBeUndefined();
  expect(demo.context.registry.numOrders).toBe(1);
  await demo.restart();
  await demo.poll(1);
  expect(demo.sendOrder).toHaveBeenCalledTimes(1);
});

it.each(["read", "sign"] as const)(
  "bounds a stalled Aave %s",
  async (request) => {
    const demo = await fixture();
    Object.assign(demo.context, { watchdogTimeout: 0.01 });
    demo[request].mockImplementationOnce(() => new Promise(() => undefined));
    await demo.poll();
    expect(demo.sendOrder).not.toHaveBeenCalled();
    expect(demo.context.registry.numOrders).toBe(1);
  }
);

it("leaves a rule watched when it becomes too late to post the quote", async () => {
  const demo = await fixture();
  demo.sign.mockImplementationOnce(async () => {
    demo.clock.mockReturnValue((expiry - 59) * 1000);
    return { order: signedOrder, signature };
  });
  await demo.poll(0, expiry - 65);
  expect(demo.sign).toHaveBeenCalledTimes(1);
  expect(demo.sendOrder).not.toHaveBeenCalled();
  expect(demo.attempt).toBeUndefined();
  expect(demo.context.registry.numOrders).toBe(1);
});
