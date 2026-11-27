import { setGlobalAdapter } from "@cowprotocol/cow-sdk";
import {
  OrderKind,
  type OrderBookApi,
  type OrderQuoteRequest,
} from "@cowprotocol/sdk-order-book";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { ethers } from "ethers";

import { AavePositionProtector__factory } from "../types";
import { AaveQuoteInputs, quoteAaveProtection } from "./aaveProtectionQuote";

const { hexZeroPad, id, parseEther, parseUnits } = ethers.utils;
const protector = hexZeroPad("0x01", 20);
const pool = hexZeroPad("0x02", 20);
const collateral = hexZeroPad("0x03", 20);
const debt = hexZeroPad("0x04", 20);
const expiry = 1_795_433_300;
const ruleId = id("protection rule");
const abi = AavePositionProtector__factory.createInterface();

function inputs(
  cap: string,
  premiumBps: number,
  {
    maxDiscount = 300,
    liquidationThreshold = 8400,
    collateralDebitBuffer = 1,
  } = {}
): AaveQuoteInputs {
  return abi.decodeFunctionResult(
    "quoteInputs",
    abi.encodeFunctionResult("quoteInputs", [
      [
        hexZeroPad("0x05", 20),
        [
          collateral,
          debt,
          parseEther("1.10"),
          parseEther("1.20"),
          parseEther(cap),
          expiry,
          maxDiscount,
        ],
        parseEther("1.10"),
        parseEther(cap),
        pool,
        parseEther("0.12"),
        parseUnits("92", 6),
        liquidationThreshold,
        premiumBps,
        parseUnits("1000", 8),
        parseUnits("1", 8),
        18,
        6,
        collateralDebitBuffer,
      ],
    ])
  )[0];
}

function quoteApi(
  proceeds: string,
  overrides: Partial<
    Awaited<ReturnType<OrderBookApi["getQuote"]>>["quote"]
  > = {}
) {
  return {
    getQuote: jest.fn(async (request: OrderQuoteRequest) => {
      if (!("sellAmountBeforeFee" in request))
        throw new Error("Expected a sell quote");
      return {
        id: 42,
        quote: {
          sellAmount: (BigInt(request.sellAmountBeforeFee) - 1n).toString(),
          buyAmount: parseUnits(proceeds, 6).toString(),
          feeAmount: "1",
          validTo: expiry,
          appDataHash: request.appDataHash,
          sellToken: request.sellToken,
          buyToken: request.buyToken,
          kind: OrderKind.SELL,
          ...overrides,
        },
      } as Awaited<ReturnType<OrderBookApi["getQuote"]>>;
    }),
  };
}

function quotePosition(
  api: Pick<OrderBookApi, "getQuote">,
  position: AaveQuoteInputs
) {
  return quoteAaveProtection(api, protector, expiry, ruleId, position);
}

beforeAll(() => {
  const provider = new ethers.providers.StaticJsonRpcProvider(undefined, 1);
  setGlobalAdapter(new EthersV5Adapter({ provider }));
});

it("quotes a full flash loan backed sell order with the Aave premium included in sizing", async () => {
  const api = quoteApi("29.7");
  const quote = await quotePosition(api, inputs("0.12", 5));
  const principal = "29809386779669216";
  if (quote.reason !== undefined) throw new Error(quote.reason);
  expect(quote.projectedHealthFactor).toBeGreaterThanOrEqual(
    parseEther("1.20").toBigInt()
  );
  expect(api.getQuote).toHaveBeenCalledWith(
    expect.objectContaining({ verificationGasLimit: 150_000 }),
    expect.anything()
  );
  expect(quote.order).toMatchObject({
    receiver: protector,
    sellAmount: principal,
    buyAmount: "28929563",
    feeAmount: "0",
    partiallyFillable: false,
    appData: id(quote.appData),
  });
  expect(quote.appData).toBe(
    `{"metadata":{"utm":{"utmContent":"aave-rule-${ruleId}"${quote.appDataSuffix}`
  );
  expect(JSON.parse(quote.appData).metadata.flashloan).toEqual({
    liquidityProvider: pool,
    protocolAdapter: protector,
    receiver: protector,
    token: collateral,
    amount: principal,
  });
});

it.each([
  ["27.8", undefined, "27.6"],
  ["27.3", "below the target", undefined],
  ["26.9", "3% below", undefined],
])(
  "checks %s USDC against both floors at the collateral cap",
  async (proceeds, reason, signedLimit) => {
    const quote = await quotePosition(
      quoteApi(proceeds),
      inputs("0.028", 0, { collateralDebitBuffer: 5 })
    );
    if (reason) {
      expect(quote).toEqual({ reason: expect.stringContaining(reason) });
      return;
    }
    if (signedLimit === undefined) throw new Error("Missing expected limit");
    if (quote.reason !== undefined) throw new Error(quote.reason);
    expect(quote.order.sellAmount).toBe("27999999999999995");
    expect(quote.estimatedCollateralDebit).toBe(parseEther("0.028").toBigInt());
    expect(quote.order.buyAmount).toBe(parseUnits(signedLimit, 6).toString());
  }
);

it("tries one bounded quote when a more favorable price can meet the target", async () => {
  const api = quoteApi("26.8");
  const quote = await quotePosition(
    api,
    inputs("0.12", 0, { maxDiscount: 4000 })
  );
  expect(api.getQuote).toHaveBeenCalledTimes(1);
  if (quote.reason !== undefined) throw new Error(quote.reason);
  expect(BigInt(quote.order.sellAmount)).toBeLessThan(
    parseEther("0.03").toBigInt()
  );
});

it.each([
  ["0.12", 9600, "Refresh the position collateral configuration"],
  ["0.01", 8400, "unreachable even at the Aave oracle price"],
])(
  "skips a swap when %s collateral cannot justify it at factor %s",
  async (cap, liquidationThreshold, reason) => {
    const api = quoteApi("29.7");
    await expect(
      quotePosition(api, inputs(cap, 0, { liquidationThreshold }))
    ).rejects.toThrow(reason);
    expect(api.getQuote).not.toHaveBeenCalled();
  }
);

it.each([{ sellToken: pool }, { buyToken: pool }, { kind: OrderKind.BUY }])(
  "rejects a response with mismatched quote terms %p",
  async (overrides) => {
    await expect(
      quotePosition(quoteApi("29.7", overrides), inputs("0.12", 5))
    ).rejects.toThrow("inconsistent flash-loan quote");
  }
);
