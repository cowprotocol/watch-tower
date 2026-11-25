import {
  Order,
  domain,
  extractOrderUidParams,
  timestamp,
} from "@cowprotocol/contracts";
import {
  areAddressesEqual,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import type { OrderCreation } from "@cowprotocol/sdk-order-book";
import {
  PollResult,
  PollResultCode,
  PollResultErrors,
  PollResultSuccess,
  fromStructToOrder,
} from "@cowprotocol/sdk-composable";
import { Wallet, constants, providers, utils } from "ethers";
import type { ChainContext } from "../../services";
import type { DBLevel } from "../../services/storage";
import type { ConditionalOrder, ContextOptions } from "../../types";
import { GPv2Settlement__factory, OrderStatus } from "../../types";
import { getOrderUid } from "../../utils/contracts";
import { withTimeout } from "../../utils/timeout";
import {
  FeeTokenSwapDraft,
  FEE_TOKEN_SWAP_DOMAIN,
  prepareFeeTokenSwapQuote,
  readFeeTokenSwapSettings,
} from "./feeTokenSwapQuote";

const inFlight = new Set<string>();
const FEE_SWAP_STATE_TIMEOUT_MS = 15_000;
const MILLISECONDS_PER_SECOND = 1_000;
const PRIVATE_KEY_BYTES = 32;
const PENDING_SWAP_VERSION = 1;
const DURABLE_WRITE = { sync: true };
const GPV2_SETTLEMENT =
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[SupportedChainId.MAINNET];
const HANDLER_ABI = new utils.Interface([
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

export interface FeeTokenSwapConfig {
  handler: string;
  pricingSigner: string;
  appData: string;
  owners?: ReadonlySet<string>;
  sellTokens: ReadonlySet<string>;
  signer?: Wallet;
}

function normalizeAddress(address: string) {
  const normalized = utils.getAddress(address).toLowerCase();
  if (normalized === constants.AddressZero) {
    throw new Error("Fee token swap config contains a zero address");
  }
  return normalized;
}

export function configureFeeTokenSwaps(
  config: ContextOptions["feeTokenSwaps"],
  chainId: number,
  dryRun: boolean
): FeeTokenSwapConfig | undefined {
  if (!config) return undefined;
  if (chainId !== SupportedChainId.MAINNET)
    throw new Error("Fee token swaps require Ethereum mainnet");
  const data: unknown = JSON.parse(config.appData);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Fee token swap appData must be a JSON object");
  }
  const sellTokens = new Set(config.sellTokens.map(normalizeAddress));
  if (sellTokens.size !== config.sellTokens.length) {
    throw new Error("Duplicate fee token swap sell token");
  }
  if (sellTokens.size === 0) {
    throw new Error("Fee token swaps need at least one supported sell token");
  }
  const normalized = {
    handler: normalizeAddress(config.handler),
    pricingSigner: normalizeAddress(config.pricingSigner),
    appData: config.appData,
    owners: config.owners && new Set(config.owners.map(normalizeAddress)),
    sellTokens,
  };
  if (dryRun) return normalized;
  const key = process.env.FEE_TOKEN_SWAP_PRICING_KEY;
  if (!key || !utils.isHexString(key, PRIVATE_KEY_BYTES)) {
    throw new Error(
      "FEE_TOKEN_SWAP_PRICING_KEY is required to sign fee quotes"
    );
  }
  const signer = new Wallet(key);
  if (!areAddressesEqual(signer.address, normalized.pricingSigner)) {
    throw new Error("Fee token swap pricing key does not match pricingSigner");
  }
  return { ...normalized, signer };
}

export async function checkFeeTokenSwapDeployment(
  {
    feeTokenSwaps,
    provider,
    contract,
    chainId,
  }: Pick<ChainContext, "feeTokenSwaps" | "provider" | "contract" | "chainId">,
  timeout: number
) {
  if (!feeTokenSwaps) return;
  const { handler } = feeTokenSwaps;
  const settlement = GPv2Settlement__factory.connect(GPV2_SETTLEMENT, provider);
  const [registryDomain, settlementDomain, handlerDomain] = await withTimeout(
    Promise.all([
      contract.domainSeparator(),
      settlement.domainSeparator(),
      provider.call({
        to: handler,
        data: HANDLER_ABI.encodeFunctionData("eip712Domain"),
      }),
    ]),
    timeout,
    "check fee swap deployment"
  );
  if (handlerDomain === "0x")
    throw new Error(
      `FeeTokenSwap handler returned no signing domain on chain ${chainId}: ${handler}`
    );
  const expected = utils._TypedDataEncoder.hashDomain(
    domain(chainId, GPV2_SETTLEMENT)
  );
  if (registryDomain !== expected || settlementDomain !== expected)
    throw new Error("Unexpected CoW settlement domain");
  const { name, version } = HANDLER_ABI.decodeFunctionResult(
    "eip712Domain",
    handlerDomain
  );
  if (
    name !== FEE_TOKEN_SWAP_DOMAIN.name ||
    version !== FEE_TOKEN_SWAP_DOMAIN.version
  )
    throw new Error("Use a FeeTokenSwap handler that supports compact quotes");
}

interface PendingSwap extends FeeTokenSwapDraft {
  submitted?: true;
}

interface SavedSwap {
  version: typeof PENDING_SWAP_VERSION;
  pending?: PendingSwap;
}

function wait(reason: string): PollResultErrors {
  return { result: PollResultCode.TRY_NEXT_BLOCK, reason };
}

async function readPending(
  db: DBLevel,
  key: string
): Promise<PendingSwap | undefined> {
  const [raw] = await db.getMany([key]);
  if (raw === undefined) return undefined;
  const slot: SavedSwap = JSON.parse(raw);
  if (slot?.version !== PENDING_SWAP_VERSION)
    throw new Error("Invalid fee token swap database entry");
  return slot.pending;
}

function savePending(db: DBLevel, key: string, pending: PendingSwap) {
  return db.put(
    key,
    JSON.stringify({ version: PENDING_SWAP_VERSION, pending }),
    DURABLE_WRITE
  );
}

export function finalizedBlockReader(provider: providers.Provider) {
  let block: Promise<providers.Block> | undefined;
  return () =>
    (block ??= withTimeout(
      provider.getBlock("finalized"),
      FEE_SWAP_STATE_TIMEOUT_MS,
      "read finalized block"
    ));
}

async function finalizedSwapStatus(
  provider: providers.Provider,
  getFinalizedBlock: FeeTokenSwapActions["getFinalizedBlock"],
  { uid, order }: PendingSwap,
  validTo: number
) {
  // A reorg can revive an order. Use finalized state before allowing another swap.
  const block = await getFinalizedBlock();
  if (!block) throw new Error("Missing finalized block");
  const settlement = GPv2Settlement__factory.connect(GPV2_SETTLEMENT, provider);
  const filledAmount = await settlement.filledAmount(uid, {
    blockTag: block.number,
  });
  if (filledAmount.eq(order.sellAmount)) return "filled";
  if (filledAmount.eq(constants.MaxUint256)) return "invalidated";
  if (block.timestamp > validTo) return "expired";
  return filledAmount.isZero() ? "open" : "partial";
}

type FeeTokenSwapActions = {
  config: FeeTokenSwapConfig;
  getFinalizedBlock: () => Promise<providers.Block>;
  getTradeableOrder: (offchainInput: string) => Promise<PollResult>;
  post: (
    order: Order & { from: string; signature: string },
    uid: string,
    feeSwap: Pick<OrderCreation, "appDataHash" | "quoteId">
  ) => Promise<
    Omit<PollResultSuccess, "order" | "signature"> | PollResultErrors
  >;
};

export async function pollFeeTokenSwap(
  context: ChainContext,
  owner: string,
  conditionalOrder: ConditionalOrder,
  blockNumber: number,
  blockTimestamp: number,
  actions: FeeTokenSwapActions
): Promise<PollResult> {
  const { config } = actions;
  const ownerAddress = owner.toLowerCase();
  if (config.owners && !config.owners.has(ownerAddress)) {
    return wait("Fee token swap wallet is not allowed");
  }
  const settings = readFeeTokenSwapSettings(conditionalOrder);
  if (!settings) return wait("Invalid fee token swap registration");
  const sellToken = settings.sellToken.toLowerCase();
  if (!config.sellTokens.has(sellToken))
    return wait("Fee token swap sell token is not supported");
  if (!areAddressesEqual(settings.pricingSigner, config.pricingSigner)) {
    return wait("Fee token swap registration uses a different pricing signer");
  }
  // Two registrations for the same balance must share one pending order.
  const key = `FEE_TOKEN_SWAP_${context.chainId}_${ownerAddress}_${sellToken}`;
  if (inFlight.has(key)) return wait("Fee token swap is already being checked");
  inFlight.add(key);
  try {
    const db = context.registry.storage.getDB();
    let pending = await readPending(db, key);
    if (!pending) {
      const result = await prepareFeeTokenSwapQuote({
        chainId: context.chainId,
        provider: context.provider,
        contract: context.contract,
        orderBookApi: context.orderBookApi,
        signer: config.signer,
        owner,
        appData: config.appData,
        conditionalOrder,
        blockNumber,
        blockTimestamp,
        dryRun: context.dryRun,
        settings,
      });
      if ("reason" in result) {
        const { reason, retryAfterSeconds } = result;
        if (!retryAfterSeconds) return wait(reason);
        const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
        return {
          result: PollResultCode.TRY_AT_EPOCH,
          reason,
          epoch: Math.max(blockTimestamp, now) + retryAfterSeconds,
        };
      }
      pending = result.draft;
      // The signed quote and exact UID must survive a crash before they reach RPC or the Order Book.
      await savePending(db, key, pending);
      conditionalOrder.consecutiveApiFailures = 0;
      conditionalOrder.lastApiError = undefined;
    }
    const { uid, order, ruleHash: conditionalOrderId, offchainInput } = pending;
    const { owner: orderOwner, validTo: expiry } = extractOrderUidParams(uid);
    const validTo = timestamp(expiry);
    if (
      orderOwner.toLowerCase() !== ownerAddress ||
      order.sellToken.toLowerCase() !== sellToken
    ) {
      throw new Error(
        "Fee swap database entry does not match its wallet and token"
      );
    }
    const status = await withTimeout(
      finalizedSwapStatus(
        context.provider,
        actions.getFinalizedBlock,
        pending,
        validTo
      ),
      FEE_SWAP_STATE_TIMEOUT_MS,
      "read finalized fee swap state"
    );
    const sameRegistration =
      typeof conditionalOrderId === "string" &&
      conditionalOrderId.toLowerCase() === conditionalOrder.id.toLowerCase();
    if (status !== "open" && status !== "partial") {
      if (!context.dryRun) await db.del(key, DURABLE_WRITE);
      if (status === "filled" && sameRegistration)
        conditionalOrder.orders.set(uid, OrderStatus.FILLED);
      return wait(`Fee token swap ${status} ${uid}`);
    }
    if (
      context.dryRun ||
      pending.submitted ||
      status === "partial" ||
      !sameRegistration ||
      blockTimestamp >= validTo
    )
      return wait(`Fee token swap pending ${uid}`);

    const polled = await withTimeout(
      actions.getTradeableOrder(offchainInput),
      FEE_SWAP_STATE_TIMEOUT_MS,
      "poll fee swap"
    );
    if (polled.result !== PollResultCode.SUCCESS)
      return wait(`Fee token swap not executable; reserved ${uid}`);

    const appDataHash = polled.order.appData as string;
    const tradeableOrder = {
      ...fromStructToOrder(polled.order),
      appData: appDataHash,
    };
    if (
      getOrderUid(context.chainId, tradeableOrder, owner) !== uid ||
      polled.signature === "0x"
    )
      return wait(`Fee token swap not executable; reserved ${uid}`);

    const result = await actions.post(
      {
        ...tradeableOrder,
        from: owner,
        appData: order.appData,
        signature: polled.signature,
      },
      uid,
      {
        appDataHash,
        quoteId: order.quoteId,
      }
    );
    if (result.result === PollResultCode.TRY_AT_EPOCH && result.epoch > validTo)
      return {
        result: PollResultCode.TRY_AT_EPOCH,
        epoch: validTo,
        reason: "Fee swap retry reaches the order deadline",
      };
    if (result.result !== PollResultCode.SUCCESS) return result;
    await savePending(db, key, { ...pending, submitted: true });
    conditionalOrder.orders.set(uid, OrderStatus.SUBMITTED);
    return wait(`Fee token swap posted ${uid}`);
  } finally {
    inFlight.delete(key);
  }
}
