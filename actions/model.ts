import Slack = require("node-slack");

import { Context, Storage } from "@tenderly/actions";
import { Transaction as SentryTransaction } from "@sentry/node";
import { BytesLike, ethers, providers } from "ethers";

import { apiUrl, getProvider } from "./utils";
import type { IConditionalOrder } from "./types/ComposableCoW";
import { PollResult, SupportedChainId } from "@cowprotocol/cow-sdk";

// Standardise the storage key
const LAST_NOTIFIED_ERROR_STORAGE_KEY = "LAST_NOTIFIED_ERROR";
const CONDITIONAL_ORDER_REGISTRY_VERSION_KEY =
  "CONDITIONAL_ORDER_REGISTRY_VERSION";
const CONDITIONAL_ORDER_REGISTRY_VERSION = 1;

export const getOrdersStorageKey = (network: string): string => {
  return `CONDITIONAL_ORDER_REGISTRY_${network}`;
};

export interface ExecutionContext {
  registry: Registry;
  notificationsEnabled: boolean;
  slack?: Slack;
  sentryTransaction?: SentryTransaction;
  context: Context;
}

export interface ReplayPlan {
  [key: number]: Set<string>;
}

export interface ProcessBlockOverrides {
  txList?: string[];
  blockWatchBlockNumber?: number;
}

/**
 * A merkle proof is a set of parameters:
 * - `merkleRoot`: the merkle root of the conditional order
 * - `path`: the path to the order in the merkle tree
 */
export type Proof = {
  merkleRoot: BytesLike;
  path: BytesLike[];
};

export type OrderUid = BytesLike;
export type Owner = string;
export enum OrderStatus {
  SUBMITTED = 1,
  FILLED = 2,
}

export type ConditionalOrder = {
  /**
   * The transaction hash that created the conditional order (useful for debugging purposes)
   */
  tx: string;

  /**
   * The parameters of the conditional order
   */
  params: IConditionalOrder.ConditionalOrderParamsStruct; // TODO: We should not use the raw `ConditionalOrderParamsStruct` instead we should do some plain object `ConditionalOrderParams` with the handler,salt,staticInput as properties. See https://github.com/cowprotocol/tenderly-watch-tower/issues/18

  /**
   * The merkle proof if the conditional order is belonging to a merkle root
   * otherwise, if the conditional order is a single order, this is null
   */
  proof: Proof | null;
  /**
   *  Map of discrete order hashes to their status
   */
  orders: Map<OrderUid, OrderStatus>;

  /**
   * the address to poll for orders (may, or **may not** be `ComposableCoW`)
   */
  composableCow: string;

  /**
   * The result of the last poll
   */
  pollResult?: {
    lastExecutionTimestamp: number;
    blockNumber: number;
    result: PollResult;
  };
};

/**
 * Models the state between executions.
 * Contains a map of owners to conditional orders and the last time we sent an error.
 */
export class Registry {
  version = CONDITIONAL_ORDER_REGISTRY_VERSION;
  ownerOrders: Map<Owner, Set<ConditionalOrder>>;
  storage: Storage;
  network: string;
  lastNotifiedError: Date | null;

  /**
   * Instantiates a registry.
   * @param ownerOrders What map to populate the registry with
   * @param storage interface to the Tenderly storage
   * @param network Which network the registry is for
   */
  constructor(
    ownerOrders: Map<Owner, Set<ConditionalOrder>>,
    storage: Storage,
    network: string,
    lastNotifiedError: Date | null
  ) {
    this.ownerOrders = ownerOrders;
    this.storage = storage;
    this.network = network;
    this.lastNotifiedError = lastNotifiedError;
  }

  /**
   * Load the registry from storage.
   * @param context from which to load the registry
   * @param network that the registry is for
   * @returns a registry instance
   */
  public static async load(
    context: Context,
    network: string
  ): Promise<Registry> {
    const str = await context.storage.getStr(getOrdersStorageKey(network));
    const lastNotifiedError = await context.storage
      .getStr(LAST_NOTIFIED_ERROR_STORAGE_KEY)
      .then((isoDate) => (isoDate ? new Date(isoDate) : null))
      .catch(() => null);

    // Get the persisted registry version
    const version = await context.storage
      .getStr(CONDITIONAL_ORDER_REGISTRY_VERSION_KEY)
      .then((versionString) => Number(versionString))
      .catch(() => undefined);

    // Parse conditional orders registry (for the persisted version, converting it to the last version)
    const ownerOrders = parseConditionalOrders(
      !!str ? str : undefined,
      version
    );

    // Return registry (on its latest version)
    return new Registry(
      ownerOrders,
      context.storage,
      network,
      lastNotifiedError
    );
  }

  get numOrders(): number {
    return Array.from(this.ownerOrders.values()).flatMap((o) => o).length;
  }

  /**
   * Write the registry to storage.
   */
  public async write(): Promise<void> {
    await Promise.all([
      this.writeOrders(),
      this.writeConditionalOrderRegistryVersion(),
      this.writeLastNotifiedError(),
    ]);
  }

  private async writeOrders(): Promise<void> {
    await this.storage.putStr(
      getOrdersStorageKey(this.network),
      this.stringifyOrders()
    );
  }

  public stringifyOrders(): string {
    return JSON.stringify(this.ownerOrders, replacer);
  }

  private async writeConditionalOrderRegistryVersion(): Promise<void> {
    await this.storage.putStr(
      CONDITIONAL_ORDER_REGISTRY_VERSION_KEY,
      this.version.toString()
    );
  }

  private async writeLastNotifiedError(): Promise<void> {
    if (this.lastNotifiedError !== null) {
      await this.storage.putStr(
        LAST_NOTIFIED_ERROR_STORAGE_KEY,
        this.lastNotifiedError.toISOString()
      );
    }
  }
}

export class ChainContext {
  provider: ethers.providers.Provider;
  apiUrl: string;
  chainId: SupportedChainId;

  constructor(
    provider: ethers.providers.Provider,
    apiUrl: string,
    chainId: SupportedChainId
  ) {
    this.provider = provider;
    this.apiUrl = apiUrl;
    this.chainId = chainId;
  }

  public static async create(
    context: Context,
    chainId: SupportedChainId
  ): Promise<ChainContext> {
    const provider = await getProvider(context, chainId);
    await provider.getNetwork();
    return new ChainContext(provider, apiUrl(chainId), chainId);
  }
}

export function _reviver(_key: any, value: any) {
  if (typeof value === "object" && value !== null) {
    if (value.dataType === "Map") {
      return new Map(value.value);
    } else if (value.dataType === "Set") {
      return new Set(value.value);
    }
  }
  return value;
}

export function replacer(_key: any, value: any) {
  if (value instanceof Map) {
    return {
      dataType: "Map",
      value: Array.from(value.entries()),
    };
  } else if (value instanceof Set) {
    return {
      dataType: "Set",
      value: Array.from(value.values()),
    };
  } else {
    return value;
  }
}
function parseConditionalOrders(
  serializedConditionalOrders: string | undefined,
  _version: number | undefined
): Map<Owner, Set<ConditionalOrder>> {
  if (!serializedConditionalOrders) {
    return new Map<Owner, Set<ConditionalOrder>>();
  }
  return JSON.parse(serializedConditionalOrders, _reviver);
}
