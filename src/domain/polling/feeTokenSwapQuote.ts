import { OrderKind as SettlementOrderKind } from "@cowprotocol/contracts";
import {
  COMPOSABLE_COW_CONTRACT_ADDRESS,
  MAX_UINT256,
  MAX_UINT32,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import {
  BuyTokenDestination,
  OrderBookApi,
  OrderCreation,
  OrderQuoteRequest,
  OrderQuoteResponse,
  OrderQuoteSideKindSell,
  SellTokenSource,
  SigningScheme,
} from "@cowprotocol/sdk-order-book";
import { ConditionalOrder as ConditionalOrderSDK } from "@cowprotocol/sdk-composable";
import { BigNumber, Wallet, constants, providers, utils } from "ethers";
import { ConditionalOrder } from "../../types/model";
import type { ComposableCoW } from "../../types/generated";
import { getOrderUid } from "../../utils/contracts";
import { withTimeout } from "../../utils/timeout";

const CHAIN_ID = SupportedChainId.MAINNET;
const AZTEC = "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2";
export const FEE_TOKEN_SWAP_DOMAIN = { name: "FeeTokenSwap", version: "2" };
const COMPOSABLE_COW = COMPOSABLE_COW_CONTRACT_ADDRESS[CHAIN_ID];
const QUOTE_TIMEOUT_MS = 15_000;
const QUOTE_RETRY_SECONDS = 30;
const RATE_LIMIT_RETRY_SECONDS = 60;
const TOO_MANY_REQUESTS = 429;
const MILLISECONDS_PER_SECOND = 1_000;
const MAX_EPOCH_SECONDS = Number(MAX_UINT32);
const MAX_AMOUNT_DIGITS = MAX_UINT256.toString().length;
const SLIPPAGE_PERCENT = 3n;
const PERCENT_BASE = 100n;

const { defaultAbiCoder } = utils;
const SETTINGS_ABI =
  "tuple(address sellToken,address buyToken,address receiver,address pricingSigner,uint256 minSellAmount,bytes32 appDataHash,uint32 maxQuoteLifetime)";
const QUOTE_ABI =
  "tuple(uint256 sellAmount,uint256 minBuyAmount,uint32 issuedAt,uint32 validTo)";
const QUOTE_TYPES = {
  Quote: [
    { name: "owner", type: "address" },
    { name: "orderId", type: "bytes32" },
    ...utils.ParamType.from(QUOTE_ABI).components.map(({ name, type }) => ({
      name,
      type,
    })),
  ],
};
const ERC20 = new utils.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

export interface FeeTokenSwapDraft {
  uid: string;
  order: Pick<
    OrderCreation,
    "sellToken" | "sellAmount" | "appData" | "quoteId"
  >;
  offchainInput: string;
  /** Conditional order ID in the persisted pending swap. */
  ruleHash: string;
}

type QuoteWait = { reason: string; retryAfterSeconds?: number };

function retryQuote(reason: string, retryAfterSeconds = QUOTE_RETRY_SECONDS) {
  return { reason, retryAfterSeconds };
}

function quoteFailure(
  error: { response?: { status?: number; headers?: Headers } } | null
): QuoteWait {
  const response = error?.response;
  if (response?.status !== TOO_MANY_REQUESTS)
    return retryQuote("Market quote unavailable or invalid");

  const retryAfter = response.headers?.get("Retry-After")?.trim() ?? "";
  const delay = /^\d+$/.test(retryAfter)
    ? Number(retryAfter)
    : Math.ceil(
        (Date.parse(retryAfter) - Date.now()) / MILLISECONDS_PER_SECOND
      );
  return retryQuote(
    "Market quote rate limited",
    Number.isSafeInteger(delay)
      ? Math.min(MAX_EPOCH_SECONDS, Math.max(RATE_LIMIT_RETRY_SECONDS, delay))
      : RATE_LIMIT_RETRY_SECONDS
  );
}

type PrepareQuoteParams = {
  chainId: SupportedChainId;
  provider: Pick<providers.Provider, "call" | "getBlock">;
  contract: Pick<ComposableCoW, "singleOrders">;
  orderBookApi: Pick<OrderBookApi, "getQuote">;
  signer?: Wallet;
  owner: string;
  appData: string;
  conditionalOrder: ConditionalOrder;
  blockNumber: number;
  blockTimestamp: number;
  dryRun: boolean;
  settings: Settings;
};

type Settings = {
  sellToken: string;
  buyToken: string;
  receiver: string;
  pricingSigner: string;
  minSellAmount: BigNumber;
  appDataHash: string;
  maxQuoteLifetime: number;
};

export function readFeeTokenSwapSettings(
  order: ConditionalOrder
): Settings | undefined {
  const { staticInput } = order.params;
  try {
    const [settings] = defaultAbiCoder.decode([SETTINGS_ABI], staticInput);
    // ABI decoding can accept trailing data. Read only the exact settings layout.
    const canonical = defaultAbiCoder.encode([SETTINGS_ABI], [settings]);
    return sameHex(canonical, staticInput) ? settings : undefined;
  } catch {
    return undefined;
  }
}

function sameHex(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase()
  );
}

function validTime(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_EPOCH_SECONDS;
}

function parseTokenAmount(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_AMOUNT_DIGITS ||
    !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw new Error("Invalid token amount");
  }
  const result = BigInt(value);
  if (result > MAX_UINT256) throw new Error("Token amount exceeds uint256");
  return result;
}

function validateRegistration(args: PrepareQuoteParams) {
  const { owner, appData, conditionalOrder, signer, settings } = args;
  try {
    const { params } = conditionalOrder;
    const conditionalOrderId = ConditionalOrderSDK.leafToId(params);
    if (
      settings.receiver === constants.AddressZero ||
      owner === constants.AddressZero ||
      conditionalOrder.proof !== null ||
      !sameHex(conditionalOrder.composableCow, COMPOSABLE_COW) ||
      !sameHex(conditionalOrder.id, conditionalOrderId) ||
      params.salt === constants.HashZero ||
      sameHex(settings.sellToken, AZTEC) ||
      !sameHex(settings.buyToken, AZTEC) ||
      !sameHex(settings.appDataHash, utils.id(appData)) ||
      !validTime(settings.maxQuoteLifetime) ||
      settings.minSellAmount.isZero() ||
      (signer && !sameHex(signer.address, settings.pricingSigner))
    )
      return;
    return conditionalOrderId;
  } catch {
    return undefined;
  }
}

async function readSnapshot(
  { provider, contract, owner, settings: { sellToken } }: PrepareQuoteParams,
  conditionalOrderId: string
) {
  const block = await provider.getBlock("latest");
  if (!block || !validTime(block.timestamp)) return;
  const { number, timestamp, hash } = block;
  // Read registration and balance at the same block so they describe one batch.
  const [data, registered] = await Promise.all([
    provider.call(
      { to: sellToken, data: ERC20.encodeFunctionData("balanceOf", [owner]) },
      number
    ),
    contract.singleOrders(owner, conditionalOrderId, {
      blockTag: number,
    }),
  ]);
  const amount: BigNumber = ERC20.decodeFunctionResult("balanceOf", data)[0];
  return { number, timestamp, hash, balance: amount.toBigInt(), registered };
}

function readQuote(
  { quote, from, id, expiration }: OrderQuoteResponse,
  request: OrderQuoteRequest & { sellAmountBeforeFee: string }
) {
  if (
    !sameHex(from, request.from) ||
    !sameHex(quote.sellToken, request.sellToken) ||
    !sameHex(quote.buyToken, request.buyToken) ||
    !sameHex(quote.receiver, request.receiver ?? "") ||
    !sameHex(quote.appDataHash, request.appDataHash ?? "") ||
    quote.kind !== String(request.kind) ||
    quote.signingScheme !== request.signingScheme ||
    quote.sellTokenBalance !== request.sellTokenBalance ||
    quote.buyTokenBalance !== request.buyTokenBalance ||
    quote.appData !== request.appData ||
    quote.partiallyFillable !== false ||
    !validTime(quote.validTo) ||
    (id != null && (!Number.isSafeInteger(id) || id < 0))
  )
    throw new Error("Market quote does not match the requested order");
  const feeExpiresAt =
    typeof expiration === "string"
      ? Math.floor(Date.parse(expiration) / MILLISECONDS_PER_SECOND)
      : NaN;
  const netSellAmount = parseTokenAmount(quote.sellAmount);
  const estimatedFee = parseTokenAmount(quote.feeAmount);
  const buyAmount = parseTokenAmount(quote.buyAmount);
  const minBuyAmount =
    (buyAmount * (PERCENT_BASE - SLIPPAGE_PERCENT)) / PERCENT_BASE;
  if (
    !validTime(feeExpiresAt) ||
    netSellAmount === 0n ||
    netSellAmount + estimatedFee !== BigInt(request.sellAmountBeforeFee) ||
    minBuyAmount === 0n
  )
    throw new Error("Invalid market quote amounts or fee deadline");
  return {
    id,
    validTo: quote.validTo,
    feeExpiresAt,
    estimatedFee,
    buyAmount,
    minBuyAmount,
  };
}

export async function prepareFeeTokenSwapQuote(
  args: PrepareQuoteParams
): Promise<{ draft: FeeTokenSwapDraft } | QuoteWait> {
  const { chainId, blockNumber, blockTimestamp, dryRun } = args;
  if (
    chainId !== CHAIN_ID ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0 ||
    !validTime(blockTimestamp)
  )
    return { reason: "FeeTokenSwap requires an Ethereum mainnet block" };
  const signingWallet = dryRun ? undefined : args.signer;
  const conditionalOrderId = validateRegistration(args);
  if (!conditionalOrderId || (!dryRun && !signingWallet))
    return { reason: "Invalid FeeTokenSwap registration" };
  const snapshot = () =>
    withTimeout(
      readSnapshot(args, conditionalOrderId),
      QUOTE_TIMEOUT_MS,
      "read fee swap snapshot"
    ).catch(() => undefined);
  const initial = await snapshot();
  if (!initial)
    return { reason: "FeeTokenSwap balance or registration unavailable" };
  if (
    initial.number < blockNumber ||
    initial.timestamp < blockTimestamp ||
    (initial.number === blockNumber && initial.timestamp !== blockTimestamp)
  )
    return { reason: "FeeTokenSwap latest block does not match the watcher" };
  if (!initial.registered)
    return { reason: "FeeTokenSwap conditional order is unregistered" };
  const { owner, appData, settings } = args;
  const sellAmount = initial.balance;
  if (sellAmount < settings.minSellAmount.toBigInt())
    return { reason: "Balance below token minimum" };

  const tokens = {
    sellToken: settings.sellToken,
    buyToken: settings.buyToken,
    receiver: settings.receiver,
  };
  const request = {
    ...tokens,
    from: owner,
    appData,
    appDataHash: settings.appDataHash,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    signingScheme: SigningScheme.EIP1271,
    kind: OrderQuoteSideKindSell.SELL,
    sellAmountBeforeFee: sellAmount.toString(),
    validTo: Math.min(
      initial.timestamp + settings.maxQuoteLifetime,
      MAX_EPOCH_SECONDS
    ),
    onchainOrder: false,
  } satisfies OrderQuoteRequest;
  // Let Watchtower schedule retries so each poll makes at most one quote request.
  const market = await withTimeout(
    args.orderBookApi.getQuote(request, { backoffOpts: { numOfAttempts: 1 } }),
    QUOTE_TIMEOUT_MS,
    "FeeTokenSwap market quote"
  )
    .then((response) => readQuote(response, request))
    .catch(quoteFailure);
  if ("reason" in market) return market;

  // The wallet and chain can change while the Order Book prepares a quote.
  const latest = await snapshot();
  if (!latest) return retryQuote("Could not recheck the batch after quoting");
  if (
    !latest.registered ||
    latest.balance < sellAmount ||
    latest.number < initial.number ||
    latest.timestamp < initial.timestamp ||
    (latest.number === initial.number && latest.hash !== initial.hash)
  )
    return retryQuote("Batch changed while quoting");
  const issuedAt = latest.timestamp;
  const validTo = Math.min(request.validTo, market.validTo);
  if (validTo <= issuedAt || market.feeExpiresAt <= issuedAt)
    return retryQuote("Market quote expired");
  if (!signingWallet)
    return retryQuote(
      `Dry run would sell ${sellAmount} base units for at least ${market.minBuyAmount} AZTEC base units. Quote bought ${market.buyAmount} base units with estimated fee ${market.estimatedFee}. Order valid to ${validTo}, fee offer expires at ${market.feeExpiresAt}.`
    );

  const quote = {
    sellAmount: request.sellAmountBeforeFee,
    minBuyAmount: market.minBuyAmount.toString(),
    issuedAt,
    validTo,
  };
  const uid = getOrderUid(
    chainId,
    {
      ...tokens,
      sellAmount: quote.sellAmount,
      buyAmount: quote.minBuyAmount,
      validTo,
      appData: settings.appDataHash,
      feeAmount: "0",
      kind: SettlementOrderKind.SELL,
      partiallyFillable: false,
    },
    owner
  );
  const order = {
    sellToken: settings.sellToken,
    sellAmount: quote.sellAmount,
    appData,
    ...(market.id == null ? {} : { quoteId: market.id }),
  };
  try {
    const signature = await signingWallet._signTypedData(
      {
        ...FEE_TOKEN_SWAP_DOMAIN,
        chainId,
        verifyingContract: args.conditionalOrder.params.handler,
      },
      QUOTE_TYPES,
      { owner, orderId: conditionalOrderId, ...quote }
    );
    const { r, yParityAndS } = utils.splitSignature(signature);
    const offchainInput = defaultAbiCoder.encode(
      [QUOTE_ABI, "bytes32", "bytes32"],
      [quote, r, yParityAndS]
    );
    return {
      draft: { uid, order, offchainInput, ruleHash: conditionalOrderId },
    };
  } catch {
    return { reason: "FeeTokenSwap pricing signature unavailable" };
  }
}
