import Slack = require("node-slack");

import { BytesLike } from "ethers";

import type { ConditionalOrderCreatedEvent } from "./generated/ComposableCoW";
import { ConditionalOrderParams, PollResult } from "@cowprotocol/cow-sdk";
import { DBService } from "../utils";

// Standardise the storage key
const LAST_NOTIFIED_ERROR_STORAGE_KEY = "LAST_NOTIFIED_ERROR";
const LAST_PROCESSED_BLOCK_STORAGE_KEY = "LAST_PROCESSED_BLOCK";
const CONDITIONAL_ORDER_REGISTRY_STORAGE_KEY = "CONDITIONAL_ORDER_REGISTRY";
const CONDITIONAL_ORDER_REGISTRY_VERSION_KEY =
  "CONDITIONAL_ORDER_REGISTRY_VERSION";
const CONDITIONAL_ORDER_REGISTRY_VERSION = 1;

export const getNetworkStorageKey = (key: string, network: string): string => {
  return `${key}_${network}`;
};

export interface ExecutionContext {
  registry: Registry;
  notificationsEnabled: boolean;
  slack?: Slack;
  storage: DBService;
}

// Todo: This should also encompass `MerkleRootSet`
export interface ReplayPlan {
  [key: number]: Set<ConditionalOrderCreatedEvent>;
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
  params: ConditionalOrderParams;

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
  storage: DBService;
  network: string;
  lastNotifiedError: Date | null;
  lastProcessedBlock: number | null;

  /**
   * Instantiates a registry.
   * @param ownerOrders What map to populate the registry with
   * @param storage storage service to use
   * @param network Which network the registry is for
   */
  constructor(
    ownerOrders: Map<Owner, Set<ConditionalOrder>>,
    storage: DBService,
    network: string,
    lastNotifiedError: Date | null,
    lastProcessedBlock: number | null
  ) {
    this.ownerOrders = ownerOrders;
    this.storage = storage;
    this.network = network;
    this.lastNotifiedError = lastNotifiedError;
    this.lastProcessedBlock = lastProcessedBlock;
  }

  /**
   * Get the raw conditional orders key from the registry.
   * @param storage The storage service to use
   * @param network The network to dump the registry for
   * @returns The conditional orders that should also be present in the tenderly version
   */
  public static async dump(
    storage: DBService,
    network: string
  ): Promise<string> {
    const ownerOrders = await loadOwnerOrders(storage, network);
    return JSON.stringify(ownerOrders, replacer, 2);
  }

  /**
   * Load the registry from storage.
   * @param context from which to load the registry
   * @param network that the registry is for
   * @returns a registry instance
   */
  public static async load(
    storage: DBService,
    network: string,
    genesisBlockNumber: number
  ): Promise<Registry> {
    const db = storage.getDB();
    const ownerOrders = await loadOwnerOrders(storage, network).catch(() =>
      createNewOrderMap()
    );
    const lastNotifiedError = await db
      .get(getNetworkStorageKey(LAST_NOTIFIED_ERROR_STORAGE_KEY, network))
      .then((isoDate: string | number | Date) =>
        isoDate ? new Date(isoDate) : null
      )
      .catch(() => null);

    const lastProcessedBlock = await db
      .get(getNetworkStorageKey(LAST_PROCESSED_BLOCK_STORAGE_KEY, network))
      .then((blockNumber: string | number) =>
        blockNumber ? Number(blockNumber) : genesisBlockNumber
      )
      .catch(() => null);

    // Return registry (on its latest version)
    return new Registry(
      ownerOrders,
      storage,
      network,
      lastNotifiedError,
      lastProcessedBlock
    );
  }

  get numOrders(): number {
    return Array.from(this.ownerOrders.values()).flatMap((o) => o).length;
  }

  /**
   * Write the registry to storage.
   */
  public async write(): Promise<void> {
    const batch = this.storage
      .getDB()
      .batch()
      .put(
        getNetworkStorageKey(
          CONDITIONAL_ORDER_REGISTRY_VERSION_KEY,
          this.network
        ),
        this.version.toString()
      )
      .put(
        getNetworkStorageKey(
          CONDITIONAL_ORDER_REGISTRY_STORAGE_KEY,
          this.network
        ),
        this.stringifyOrders()
      );

    // Write or delete last notified error
    if (this.lastNotifiedError !== null) {
      batch.put(
        getNetworkStorageKey(LAST_NOTIFIED_ERROR_STORAGE_KEY, this.network),
        this.lastNotifiedError.toISOString()
      );
    } else {
      batch.del(
        getNetworkStorageKey(LAST_NOTIFIED_ERROR_STORAGE_KEY, this.network)
      );
    }

    // Write or delete last processed block
    if (this.lastProcessedBlock !== null) {
      batch.put(
        getNetworkStorageKey(LAST_PROCESSED_BLOCK_STORAGE_KEY, this.network),
        this.lastProcessedBlock.toString()
      );
    } else {
      batch.del(
        getNetworkStorageKey(LAST_PROCESSED_BLOCK_STORAGE_KEY, this.network)
      );
    }

    // Write all atomically
    await batch.write();
  }

  public stringifyOrders(): string {
    return JSON.stringify(this.ownerOrders, replacer);
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

async function loadOwnerOrders(
  storage: DBService,
  network: string
): Promise<Map<string, Set<ConditionalOrder>>> {
  // Get the owner orders
  const db = storage.getDB();
  const str = await db.get(
    getNetworkStorageKey(CONDITIONAL_ORDER_REGISTRY_STORAGE_KEY, network)
  );
  // Get the persisted registry version
  const version = await db.get(
    getNetworkStorageKey(CONDITIONAL_ORDER_REGISTRY_VERSION_KEY, network)
  );

  // Parse conditional orders registry (for the persisted version, converting it to the last version)
  const ownerOrders = parseConditionalOrders(
    !!str ? str : undefined,
    Number(version)
  );

  return ownerOrders;
}

function parseConditionalOrders(
  serializedConditionalOrders: string | undefined,
  _version: number | undefined
): Map<Owner, Set<ConditionalOrder>> {
  if (!serializedConditionalOrders) {
    return createNewOrderMap();
  }
  return JSON.parse(serializedConditionalOrders, _reviver);
}

function createNewOrderMap(): Map<Owner, Set<ConditionalOrder>> {
  return new Map<Owner, Set<ConditionalOrder>>();
}
