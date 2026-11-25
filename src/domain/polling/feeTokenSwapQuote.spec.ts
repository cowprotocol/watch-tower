import {
  computeOrderUid,
  domain,
  extractOrderUidParams,
  OrderBalance,
  OrderKind as SettlementOrderKind,
} from "@cowprotocol/contracts";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  SupportedChainId,
  setGlobalAdapter,
} from "@cowprotocol/cow-sdk";
import { PollResultCode } from "@cowprotocol/sdk-composable";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import {
  OrderKind,
  OrderQuoteResponse,
  OrderQuoteSideKindSell,
  SellTokenSource,
  BuyTokenDestination,
  SigningScheme,
} from "@cowprotocol/sdk-order-book";
import { Wallet, constants, providers, utils } from "ethers";
import type { ChainContext } from "../../services";
import {
  ComposableCoW__factory,
  ConditionalOrder,
  ConditionalOrderCreatedEvent,
  GPv2Settlement__factory,
} from "../../types";
import { initLogging } from "../../utils";
import { processNewOrderEvent } from "../events";
import { checkForAndPlaceOrder } from ".";
import {
  checkFeeTokenSwapDeployment,
  configureFeeTokenSwaps,
  pollFeeTokenSwap,
} from "./feeTokenSwap";
import {
  prepareFeeTokenSwapQuote,
  readFeeTokenSwapSettings,
} from "./feeTokenSwapQuote";

const CHAIN_ID = SupportedChainId.MAINNET;
const COMPOSABLE_COW = COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID];
const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const OWNER = "0x1000000000000000000000000000000000000001";
const HANDLER = "0x3000000000000000000000000000000000000003";
const SIGNER = new Wallet(utils.hexZeroPad("0x01", 32));
const SALT = utils.hexZeroPad("0x02", 32);
const TOKENS = {
  sellToken: utils.getAddress("0x6b175474e89094c44da98b954eedeac495271d0f"),
  buyToken: utils.getAddress("0xa27ec0006e59f245217ff08cd52a7e8b169e62d2"),
  receiver: "0x2000000000000000000000000000000000000002",
};
const { sellToken: DAI, receiver: RECEIVER } = TOKENS;
const NOW = 1_784_000_000;
const FIRST_BLOCK = 100;
const QUOTE_TIME = NOW + 12;
const ORDER_DEADLINE = NOW + 300;
const APP_DATA = '{"version":"1.1.0","metadata":{}}';
const APP_DATA_HASH = utils.id(APP_DATA);
const TOKEN = 10n ** 18n;
const MINIMUM = 100n * TOKEN;
const QUOTE_ID = 17;
const { defaultAbiCoder } = utils;
const QUOTE_ABI =
  "(uint256 sellAmount,uint256 minBuyAmount,uint32 issuedAt,uint32 validTo)";
const ERC20 = new utils.Interface([
  "function balanceOf(address) view returns (uint256)",
]);
const SETTLEMENT_ABI = GPv2Settlement__factory.createInterface();
const QUOTE_FIELDS = {
  sellAmount: MINIMUM.toString(),
  minBuyAmount: "117",
  issuedAt: QUOTE_TIME,
  validTo: ORDER_DEADLINE,
};
const SETTLEMENT_ORDER = {
  ...TOKENS,
  sellAmount: QUOTE_FIELDS.sellAmount,
  buyAmount: QUOTE_FIELDS.minBuyAmount,
  validTo: ORDER_DEADLINE,
  appData: APP_DATA_HASH,
  feeAmount: "0",
  kind: SettlementOrderKind.SELL,
  partiallyFillable: false,
  sellTokenBalance: OrderBalance.ERC20,
  buyTokenBalance: OrderBalance.ERC20,
};
const UID = computeOrderUid(
  domain(CHAIN_ID, SETTLEMENT),
  SETTLEMENT_ORDER,
  OWNER
);

type FeeSwapOptions = NonNullable<Parameters<typeof configureFeeTokenSwaps>[0]>;

const WATCHTOWER_CONFIG: FeeSwapOptions = {
  handler: HANDLER,
  pricingSigner: SIGNER.address,
  appData: APP_DATA,
  sellTokens: [DAI],
};
const SAVED_ORDER = {
  sellToken: DAI,
  sellAmount: QUOTE_FIELDS.sellAmount,
  appData: APP_DATA,
  quoteId: QUOTE_ID,
};
const SETTINGS = {
  ...TOKENS,
  pricingSigner: SIGNER.address,
  minSellAmount: MINIMUM,
  appDataHash: APP_DATA_HASH,
  maxQuoteLifetime: ORDER_DEADLINE - NOW,
};
const QUOTE_TERMS = {
  ...TOKENS,
  appData: APP_DATA,
  appDataHash: APP_DATA_HASH,
  validTo: ORDER_DEADLINE,
  sellTokenBalance: SellTokenSource.ERC20,
  buyTokenBalance: BuyTokenDestination.ERC20,
  signingScheme: SigningScheme.EIP1271,
};

function conditionalOrder(
  settings: Partial<typeof SETTINGS> = {},
  salt = SALT
) {
  const staticInput = defaultAbiCoder.encode(
    [
      "tuple(address sellToken,address buyToken,address receiver,address pricingSigner,uint256 minSellAmount,bytes32 appDataHash,uint32 maxQuoteLifetime)",
    ],
    [{ ...SETTINGS, ...settings }]
  );
  return {
    id: utils.keccak256(
      defaultAbiCoder.encode(
        ["(address,bytes32,bytes)"],
        [[HANDLER, salt, staticInput]]
      )
    ),
    params: { handler: HANDLER, salt, staticInput },
    orders: new Map(),
    proof: null,
    tx: "0x",
    composableCow: COMPOSABLE_COW,
  } satisfies ConditionalOrder;
}

type Snapshot = { balance: bigint; registered: boolean };
function fixture({
  first,
  latest,
  response,
  quote,
  settings,
  finalizedAt = QUOTE_TIME,
}: {
  first?: Partial<Snapshot>;
  latest?: Partial<Snapshot>;
  response?: Partial<OrderQuoteResponse>;
  quote?: Partial<OrderQuoteResponse["quote"]>;
  settings?: Partial<typeof SETTINGS>;
  finalizedAt?: number;
} = {}) {
  const order = conditionalOrder(settings);
  const sellToken = utils.getAddress(settings?.sellToken ?? DAI);
  const initial = { balance: MINIMUM, registered: true, ...first };
  const states = [initial, { ...initial, ...latest }];
  const provider = new providers.JsonRpcProvider();
  let next = FIRST_BLOCK;
  const getBlock = jest
    .spyOn(provider, "getBlock")
    .mockImplementation(async (tag) => {
      const number = tag === "finalized" ? FIRST_BLOCK + 1 : next++;
      const timestamp =
        tag === "finalized"
          ? finalizedAt
          : number === FIRST_BLOCK
          ? NOW
          : QUOTE_TIME;
      return { number, timestamp, hash: String(number) } as providers.Block;
    });
  const call = jest
    .spyOn(provider, "call")
    .mockImplementation(async (tx, blockTag) => {
      if (String(tx.to).toLowerCase() === SETTLEMENT.toLowerCase())
        return SETTLEMENT_ABI.encodeFunctionResult("filledAmount", [0]);
      expect(tx).toMatchObject({
        to: sellToken,
        data: ERC20.encodeFunctionData("balanceOf", [OWNER]),
      });
      return ERC20.encodeFunctionResult("balanceOf", [
        states[Number(blockTag) - FIRST_BLOCK].balance,
      ]);
    });
  const singleOrders = jest.fn(async (owner, id, { blockTag }) => {
    expect([owner, id]).toEqual([OWNER, order.id]);
    return states[blockTag - FIRST_BLOCK].registered;
  });
  const getQuote = jest.fn().mockResolvedValue({
    from: OWNER,
    id: QUOTE_ID,
    expiration: new Date((NOW + 60) * 1000).toISOString(),
    ...response,
    quote: {
      ...QUOTE_TERMS,
      sellToken,
      sellAmount: (MINIMUM - TOKEN).toString(),
      feeAmount: TOKEN.toString(),
      buyAmount: "121",
      kind: OrderKind.SELL,
      partiallyFillable: false,
      ...quote,
    },
  });
  const args = {
    chainId: CHAIN_ID,
    provider,
    contract: { singleOrders },
    orderBookApi: { getQuote },
    signer: SIGNER,
    conditionalOrder: order,
    owner: OWNER,
    appData: APP_DATA,
    blockNumber: FIRST_BLOCK,
    blockTimestamp: NOW,
    dryRun: false,
  };
  const prepare = (
    overrides: Partial<Parameters<typeof prepareFeeTokenSwapQuote>[0]> = {}
  ) => {
    const input = { ...args, ...overrides };
    const decoded = readFeeTokenSwapSettings(input.conditionalOrder);
    if (!decoded) throw new Error("Invalid test registration");
    return prepareFeeTokenSwapQuote({ ...input, settings: decoded });
  };
  return { args, prepare, getBlock, call, getQuote };
}

async function signedDraft(scenario: ReturnType<typeof fixture>) {
  const result = await scenario.prepare();
  if (!("draft" in result)) throw new Error(result.reason);
  return result.draft;
}

function pollFixture({
  config = WATCHTOWER_CONFIG,
  pending,
  finalizedAt = QUOTE_TIME,
  dryRun = false,
}: {
  config?: FeeSwapOptions;
  pending?: object;
  finalizedAt?: number;
  dryRun?: boolean;
} = {}) {
  const { args, getQuote, getBlock, call } = fixture({ finalizedAt });
  const db = {
    getMany: jest
      .fn()
      .mockResolvedValue([
        pending
          ? JSON.stringify({ version: 1, pilot: true, pending })
          : undefined,
      ]),
    put: jest.fn(),
    del: jest.fn(),
  };
  const feeTokenSwaps = configureFeeTokenSwaps(config, CHAIN_ID, true);
  if (!feeTokenSwaps) throw new Error("Missing fee swap test config");
  const context = {
    ...args,
    dryRun,
    feeTokenSwaps,
    registry: { storage: { getDB: () => db } },
  } as unknown as ChainContext;
  const tradeableOrder = {
    result: PollResultCode.SUCCESS,
    signature: "0x01",
    order: {
      ...SETTLEMENT_ORDER,
      kind: utils.id("sell"),
      sellTokenBalance: utils.id("erc20"),
      buyTokenBalance: utils.id("erc20"),
    },
  };
  const getTradeableOrder = jest.fn().mockResolvedValue(tradeableOrder);
  const post = jest.fn().mockResolvedValue({ result: PollResultCode.SUCCESS });
  const run = () =>
    pollFeeTokenSwap(
      context,
      OWNER,
      args.conditionalOrder,
      FIRST_BLOCK,
      pending ? finalizedAt : NOW,
      {
        config: feeTokenSwaps,
        getFinalizedBlock: () => args.provider.getBlock("finalized"),
        getTradeableOrder,
        post,
      }
    );
  return {
    context,
    finalized: getBlock,
    settlement: call,
    db,
    getQuote,
    tradeableOrder,
    getTradeableOrder,
    post,
    run,
  };
}

beforeAll(() => {
  initLogging({});
  setGlobalAdapter(
    new EthersV5Adapter({ provider: new providers.JsonRpcProvider() })
  );
});
afterEach(() => jest.restoreAllMocks());

it("accepts the canonical event and replaces a foreign registration", async () => {
  const order = conditionalOrder();
  const ownerOrders = new Map<string, Set<ConditionalOrder>>();
  const context = {
    chainId: CHAIN_ID,
    registry: { network: String(CHAIN_ID), ownerOrders, write: jest.fn() },
    contract: { address: COMPOSABLE_COW },
    feeTokenSwaps: configureFeeTokenSwaps(WATCHTOWER_CONFIG, CHAIN_ID, true),
  } as unknown as ChainContext;
  const event = {
    ...ComposableCoW__factory.createInterface().encodeEventLog(
      "ConditionalOrderCreated",
      [OWNER, order.params]
    ),
    address: RECEIVER,
    blockNumber: FIRST_BLOCK,
    transactionHash: order.tx,
  } as ConditionalOrderCreatedEvent;
  await processNewOrderEvent(context, event);
  expect(ownerOrders.size).toBe(0);
  ownerOrders.set(OWNER, new Set([{ ...order, composableCow: RECEIVER }]));
  await processNewOrderEvent(context, { ...event, address: COMPOSABLE_COW });
  expect([...(ownerOrders.get(OWNER) ?? [])]).toEqual([order]);
});

it.each([
  [{ owners: [RECEIVER] }, "wallet is not allowed"],
  [{ sellTokens: [RECEIVER] }, "sell token is not supported"],
  [{ pricingSigner: RECEIVER }, "registration uses a different pricing signer"],
] satisfies [Partial<FeeSwapOptions>, string][])(
  "applies handler config %j",
  async (overrides, reason) => {
    const { run, getQuote, post, db } = pollFixture({
      config: { ...WATCHTOWER_CONFIG, ...overrides },
      dryRun: true,
    });
    await expect(run()).resolves.toMatchObject({
      reason: expect.stringContaining(reason),
    });
    expect(getQuote).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(db.put).not.toHaveBeenCalled();
  }
);

function savedSwap({
  legacy = false,
  missingId = false,
  ...options
}: {
  legacy?: boolean;
  missingId?: boolean;
  finalizedAt?: number;
  dryRun?: boolean;
} = {}) {
  const quote = Object.values(QUOTE_FIELDS);
  const input = legacy
    ? defaultAbiCoder.encode(
        [QUOTE_ABI, "bytes"],
        [quote, utils.joinSignature({ r: SALT, _vs: SALT })]
      )
    : defaultAbiCoder.encode(
        [QUOTE_ABI, "bytes32", "bytes32"],
        [quote, SALT, SALT]
      );
  const pending = {
    uid: UID,
    order: SAVED_ORDER,
    ruleHash: missingId ? undefined : conditionalOrder().id,
    offchainInput: input,
  };
  return { input, ...pollFixture({ pending, ...options }) };
}

it("does not quote when reading the saved swap fails", async () => {
  const { db, getQuote, run } = pollFixture();
  db.getMany.mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(run()).rejects.toThrow("Database unavailable");
  expect(getQuote).not.toHaveBeenCalled();
  expect(db.put).not.toHaveBeenCalled();
});

it.each([false, true])(
  "replays the same order and quote (legacy: %s)",
  async (legacy) => {
    const { input, db, getQuote, getTradeableOrder, post, run } = savedSwap({
      legacy,
    });
    await expect(run()).resolves.toMatchObject({
      reason: `Fee token swap posted ${UID}`,
    });
    expect(getQuote).not.toHaveBeenCalled();
    expect(getTradeableOrder).toHaveBeenCalledWith(input);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ signature: "0x01" }),
      UID,
      {
        appDataHash: APP_DATA_HASH,
        quoteId: QUOTE_ID,
      }
    );
    expect(JSON.parse(db.put.mock.calls[0][1]).pending).toMatchObject({
      uid: UID,
      submitted: true,
    });
  }
);

it("keeps the saved swap when the tradeable order has a different UID", async () => {
  const { db, getTradeableOrder, post, run, tradeableOrder } = savedSwap();
  getTradeableOrder.mockResolvedValueOnce({
    ...tradeableOrder,
    order: { ...tradeableOrder.order, receiver: OWNER },
  });
  await expect(run()).resolves.toMatchObject({
    result: PollResultCode.TRY_NEXT_BLOCK,
    reason: expect.stringContaining("reserved"),
  });
  expect(post).not.toHaveBeenCalled();
  expect(db.del).not.toHaveBeenCalled();
  expect(db.put).not.toHaveBeenCalled();
});

it("shares one finalized read per pass, including after a failure", async () => {
  const { context, finalized, settlement } = savedSwap({
    finalizedAt: ORDER_DEADLINE + 1,
    dryRun: true,
  });
  const orders = [
    conditionalOrder(),
    conditionalOrder({}, utils.hexZeroPad("0x03", 32)),
  ];
  Object.assign(context.registry, {
    ownerOrders: new Map([[OWNER, new Set(orders)]]),
    numOwners: 1,
    numOrders: orders.length,
    prune: () => 0,
    write: jest.fn(),
  });
  const poll = () =>
    checkForAndPlaceOrder(context, {
      number: FIRST_BLOCK + 2,
      timestamp: ORDER_DEADLINE + 2,
    } as providers.Block);
  finalized.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(poll()).rejects.toThrow("unexpected error");
  expect(finalized).toHaveBeenCalledTimes(1);
  expect(settlement).not.toHaveBeenCalled();

  await poll();
  expect(finalized.mock.calls).toEqual([["finalized"], ["finalized"]]);
  expect(settlement.mock.calls.map(([, block]) => block)).toEqual([
    FIRST_BLOCK + 1,
    FIRST_BLOCK + 1,
  ]);
});

it("caps the next post attempt at the saved UID deadline", async () => {
  const { db, post, run } = savedSwap();
  post.mockResolvedValue({
    result: PollResultCode.TRY_AT_EPOCH,
    epoch: ORDER_DEADLINE + 60,
  });
  await expect(run()).resolves.toMatchObject({
    result: PollResultCode.TRY_AT_EPOCH,
    epoch: ORDER_DEADLINE,
  });
  expect(db.del).not.toHaveBeenCalled();
  expect(db.put).not.toHaveBeenCalled();
});

it.each([false, true])(
  "frees the finalized expired slot (missing order ID: %s)",
  async (missingId) => {
    const { db, getQuote, post, run } = savedSwap({
      finalizedAt: ORDER_DEADLINE + 1,
      missingId,
    });
    await expect(run()).resolves.toMatchObject({
      reason: `Fee token swap expired ${UID}`,
    });
    expect(db.del).toHaveBeenCalledWith(
      expect.stringContaining(OWNER.toLowerCase()),
      { sync: true }
    );
    expect(db.put).not.toHaveBeenCalled();
    expect(getQuote).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  }
);

it("signs the original gross balance and keeps the fee deadline separate", async () => {
  const scenario = fixture({
    quote: { validTo: NOW + 400 },
    latest: { balance: 102n * TOKEN },
  });
  const draft = await signedDraft(scenario);
  expect(scenario.getQuote).toHaveBeenCalledWith(
    {
      ...QUOTE_TERMS,
      from: OWNER,
      kind: OrderQuoteSideKindSell.SELL,
      sellAmountBeforeFee: MINIMUM.toString(),
      onchainOrder: false,
    },
    { backoffOpts: { numOfAttempts: 1 } }
  );
  expect(draft).toMatchObject({
    order: SAVED_ORDER,
    uid: UID,
    ruleHash: scenario.args.conditionalOrder.id,
  });
  expect(utils.hexDataLength(draft.offchainInput)).toBe(192);
  const [quote, r, vs] = defaultAbiCoder.decode(
    [QUOTE_ABI, "bytes32", "bytes32"],
    draft.offchainInput
  );
  expect(quote.map(String)).toEqual(Object.values(QUOTE_FIELDS).map(String));
  const signer = utils.verifyTypedData(
    {
      name: "FeeTokenSwap",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: HANDLER,
    },
    {
      Quote: [
        { name: "owner", type: "address" },
        { name: "orderId", type: "bytes32" },
        ...utils.ParamType.from(QUOTE_ABI).components.map(({ name, type }) => ({
          name,
          type,
        })),
      ],
    },
    {
      owner: OWNER,
      orderId: scenario.args.conditionalOrder.id,
      ...QUOTE_FIELDS,
    },
    utils.joinSignature({ r, _vs: vs })
  );
  expect(signer).toBe(SIGNER.address);
  expect(extractOrderUidParams(draft.uid)).toMatchObject({
    owner: OWNER,
    validTo: ORDER_DEADLINE,
  });
});

it("keeps a shorter quoted order deadline and omits an absent quote ID", async () => {
  const validTo = NOW + 200;
  const draft = await signedDraft(
    fixture({ response: { id: undefined }, quote: { validTo } })
  );
  expect(extractOrderUidParams(draft.uid).validTo).toBe(validTo);
  expect(draft.order).not.toHaveProperty("quoteId");
});

it.each([
  ["Balance below token minimum", { balance: MINIMUM - TOKEN }],
  ["FeeTokenSwap conditional order is unregistered", { registered: false }],
] as const)("rejects %s before requesting a quote", async (reason, first) => {
  const { prepare, getQuote } = fixture({ first });
  await expect(prepare()).resolves.toEqual({ reason });
  expect(getQuote).not.toHaveBeenCalled();
});

it.each([
  [DAI, MINIMUM, 123n * TOKEN, TOKEN],
  [
    "0x4000000000000000000000000000000000000004",
    100_000_000n,
    100_000_000n,
    1_000_000n,
  ],
] as const)(
  "quotes the full balance in base units for %s",
  async (sellToken, minSellAmount, balance, fee) => {
    const scenario = fixture({
      settings: { sellToken, minSellAmount },
      first: { balance },
      quote: { sellAmount: String(balance - fee), feeAmount: String(fee) },
    });
    const { order } = await signedDraft(scenario);
    expect(order).toMatchObject({ sellToken, sellAmount: String(balance) });
    expect(scenario.getQuote).toHaveBeenCalledTimes(1);
    expect(scenario.getQuote.mock.calls[0][0].sellAmountBeforeFee).toBe(
      String(balance)
    );
  }
);

it.each([
  ["balance falls", { balance: MINIMUM - TOKEN }],
  ["order is removed", { registered: false }],
] as const)(
  "rejects the changed batch after quoting when %s",
  async (_, latest) => {
    const { prepare, getBlock, getQuote } = fixture({ latest });
    await expect(prepare()).resolves.toMatchObject({
      reason: "Batch changed while quoting",
    });
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledTimes(2);
  }
);

it.each([
  ["gross amount", { quote: { sellAmount: MINIMUM.toString() } }],
  ["fee syntax", { quote: { feeAmount: "1e18" } }],
  ["zero output after rounding", { quote: { buyAmount: "1" } }],
  ["buy token", { quote: { buyToken: DAI } }],
  ["receiver", { quote: { receiver: OWNER } }],
  ["app data", { quote: { appData: "{}" } }],
  ["app data hash", { quote: { appDataHash: constants.HashZero } }],
  ["partial fill", { quote: { partiallyFillable: true } }],
  ["signature scheme", { quote: { signingScheme: SigningScheme.EIP712 } }],
  ["quote ID", { response: { id: -1 } }],
  ["owner", { response: { from: RECEIVER } }],
  ["expiry", { response: { expiration: "invalid date" } }],
] as const)("rejects invalid market quote %s", async (_, options) => {
  await expect(fixture(options).prepare()).resolves.toEqual({
    reason: "Market quote unavailable or invalid",
    retryAfterSeconds: 30,
  });
});

it("honors the Order Book retry delay on rate limit", async () => {
  const { prepare, getQuote } = fixture();
  getQuote.mockRejectedValue({
    response: { status: 429, headers: { get: () => "75" } },
  });
  await expect(prepare()).resolves.toEqual({
    reason: "Market quote rate limited",
    retryAfterSeconds: 75,
  });
});

it("rejects a fee offer that expires while quoting", async () => {
  const { prepare } = fixture({
    response: { expiration: new Date(QUOTE_TIME * 1000).toISOString() },
  });
  await expect(prepare()).resolves.toEqual({
    reason: "Market quote expired",
    retryAfterSeconds: 30,
  });
});

it("checks chain and registration details before RPC", async () => {
  const { args, prepare, getBlock } = fixture();
  await expect(
    prepare({ chainId: SupportedChainId.GNOSIS_CHAIN })
  ).resolves.toEqual({
    reason: "FeeTokenSwap requires an Ethereum mainnet block",
  });
  for (const overrides of [
    { appData: "{}" },
    { signer: new Wallet(utils.hexZeroPad("0x03", 32)) },
    { signer: undefined },
    {
      conditionalOrder: { ...args.conditionalOrder, id: constants.HashZero },
    },
    { conditionalOrder: conditionalOrder({}, constants.HashZero) },
    {
      conditionalOrder: {
        ...args.conditionalOrder,
        proof: { merkleRoot: SALT, path: [] },
      },
    },
  ]) {
    await expect(prepare(overrides)).resolves.toEqual({
      reason: "Invalid FeeTokenSwap registration",
    });
  }
  expect(getBlock).not.toHaveBeenCalled();
});

it.each([false, true])(
  "previews in dry run (signer available: %s)",
  async (hasSigner) => {
    const { context, run, getQuote, post, db } = pollFixture({ dryRun: true });
    if (hasSigner && context.feeTokenSwaps)
      context.feeTokenSwaps.signer = SIGNER;
    jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const sign = jest.spyOn(SIGNER, "_signTypedData");
    await expect(run()).resolves.toMatchObject({
      result: PollResultCode.TRY_AT_EPOCH,
      epoch: NOW + 30,
      reason: expect.stringContaining("for at least 117 AZTEC base units"),
    });
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(sign).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(db.put).not.toHaveBeenCalled();
  }
);

it("decodes the token and signer and rejects additional or truncated bytes", () => {
  const order = conditionalOrder();
  expect(readFeeTokenSwapSettings(order)).toMatchObject({
    sellToken: DAI,
    pricingSigner: SIGNER.address,
  });
  for (const staticInput of [order.params.staticInput + "00", "0x"]) {
    expect(
      readFeeTokenSwapSettings({
        ...order,
        params: { ...order.params, staticInput },
      })
    ).toBeUndefined();
  }
});

const EXPECTED_DOMAIN = utils._TypedDataEncoder.hashDomain(
  domain(CHAIN_ID, SETTLEMENT)
);
const HANDLER_ABI = new utils.Interface([
  "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])",
]);

it.each([
  ["settlement", "Unexpected CoW settlement domain"],
  ["registry", "Unexpected CoW settlement domain"],
  ["no handler domain", "handler returned no signing domain"],
  ["legacy handler", "Use a FeeTokenSwap handler that supports compact quotes"],
  ["compact handler", undefined],
])("checks the %s during startup", async (test, error) => {
  const provider = new providers.JsonRpcProvider();
  const handlerDomain =
    test === "no handler domain"
      ? "0x"
      : HANDLER_ABI.encodeFunctionResult("eip712Domain", [
          "0x0f",
          "FeeTokenSwap",
          test === "legacy handler" ? "1" : "2",
          CHAIN_ID,
          HANDLER,
          constants.HashZero,
          [],
        ]);
  const settlementDomain =
    test === "settlement" ? constants.HashZero : EXPECTED_DOMAIN;
  jest
    .spyOn(provider, "call")
    .mockImplementation(async ({ to }) =>
      to === HANDLER
        ? handlerDomain
        : SETTLEMENT_ABI.encodeFunctionResult("domainSeparator", [
            settlementDomain,
          ])
    );
  const registryDomain =
    test === "registry" ? constants.HashZero : EXPECTED_DOMAIN;
  const context = {
    chainId: CHAIN_ID,
    provider,
    contract: {
      domainSeparator: jest.fn().mockResolvedValue(registryDomain),
    },
    feeTokenSwaps: { handler: HANDLER },
  } as unknown as ChainContext;
  const check = checkFeeTokenSwapDeployment(context, 1000);
  if (error) await expect(check).rejects.toThrow(error);
  else await expect(check).resolves.toBeUndefined();
});
