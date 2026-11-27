import Slack = require("node-slack");

import { BytesLike } from "ethers";

import {
  ConditionalOrderParams,
  ConditionalOrder as ConditionalOrderSdk,
  PollResult,
} from "@cowprotocol/sdk-composable";
import type { OrderCreation } from "@cowprotocol/sdk-order-book";
import type { DBLevel, DBService } from "../services/storage";
import { getLogger } from "../utils/logging";
import * as metrics from "../utils/metrics";

// Standardise the storage key
const LAST_NOTIFIED_ERROR_STORAGE_KEY = "LAST_NOTIFIED_ERROR";
const LAST_PROCESSED_BLOCK_STORAGE_KEY = "LAST_PROCESSED_BLOCK";
const AAVE_ORDER_PAYLOADS_STORAGE_KEY = "AAVE_ORDER_PAYLOADS";
const CONDITIONAL_ORDER_REGISTRY_STORAGE_KEY = "CONDITIONAL_ORDER_REGISTRY";
const CONDITIONAL_ORDER_REGISTRY_VERSION_KEY =
  "CONDITIONAL_ORDER_REGISTRY_VERSION";
const CONDITIONAL_ORDER_REGISTRY_VERSION = 2;

export const getNetworkStorageKey = (key: string, network: string): string => {
  return `${key}_${network}`;
};

export interface ExecutionContext {
  registry: Registry;
  notificationsEnabled: boolean;
  slack?: Slack;
  storage: DBService;
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

export type AaveOrderAttempt = {
  uid: string;
  validTo: number;
  state: "pending" | "lookup-only" | "accepted";
  payload?: OrderCreation;
};

export type ConditionalOrder = {
  /**
   * Id of the conditional order (which also happens to be the key used for `ctx` in the ComposableCoW contract).
   *
   * This is a `keccak256` hash of the serialized conditional order.
   */
  id: string;

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

  /** The Aave order UID and the submission payload while acceptance is unknown. */
  aaveOrderAttempt?: AaveOrderAttempt;

  /**
   * the address to poll for orders (may, or **may not** be `ComposableCoW`)
   */
  composableCow: string;

  /**
   * Chain timestamp at which this conditional order was first seen.
   *
   * Backfilled on first poll for orders persisted before this field existed,
   * so the clock starts at that point rather than being unknown forever.
   */
  createdAtEpoch?: number;

  /**
   * How many times in a row placing this order has been rejected by the API.
   *
   * Drives an escalating backoff so an order that is permanently invalid (bad
   * EIP-1271 signature, unknown appData pre-image) stops being retried on every
   * block. Reset to `0` as soon as an order is accepted.
   */
  consecutiveApiFailures?: number;

  /**
   * The API error type behind `consecutiveApiFailures`.
   *
   * The backoff tiers mean "this order keeps failing the same way", so the
   * count restarts when the API starts rejecting it for a different reason.
   */
  lastApiError?: string;

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
 * Drop discrete orders that can no longer be placed from the dedup map.
 *
 * `orders` only exists to avoid re-posting an `orderUid` we have already
 * submitted. Once an order's `validTo` has passed it can never be posted
 * again, so retaining it serves no purpose - and left unbounded this map is
 * what makes the persisted registry grow into the tens of megabytes.
 *
 * @returns the number of entries removed
 */
export function pruneExpiredOrders(
  orders: Map<OrderUid, OrderStatus>,
  nowEpoch: number
): number {
  let pruned = 0;

  // Deleting while iterating a `Map` is well defined - entries already visited
  // are unaffected and the deleted key is simply skipped.
  for (const orderUid of orders.keys()) {
    const validTo = getOrderUidValidTo(orderUid);
    if (validTo !== undefined && validTo < nowEpoch) {
      orders.delete(orderUid);
      pruned++;
    }
  }

  return pruned;
}

/** 32 byte order digest + 20 byte owner + 4 byte `validTo`, as hex characters */
const ORDER_UID_HEX_CHARS = 2 * (32 + 20 + 4);
const VALID_TO_HEX_LENGTH = 2 * 4;

/** A complete GPv2 order uid: `0x` followed by 112 hex characters */
const ORDER_UID_PATTERN = new RegExp(`^0x[0-9a-fA-F]{${ORDER_UID_HEX_CHARS}}$`);

/**
 * Read the `validTo` encoded in the trailing 4 bytes of a GPv2 order uid.
 * Returns `undefined` for anything that isn't a well formed uid, so unknown
 * entries are retained rather than silently discarded.
 *
 * The uid must be validated in full before parsing: `parseInt` stops at the
 * first invalid character instead of returning `NaN`, so a corrupt uid would
 * otherwise yield a truncated `validTo` that looks long expired and be pruned.
 */
function getOrderUidValidTo(orderUid: OrderUid): number | undefined {
  if (typeof orderUid !== "string" || !ORDER_UID_PATTERN.test(orderUid)) {
    return undefined;
  }

  return Number.parseInt(orderUid.slice(-VALID_TO_HEX_LENGTH), 16);
}

export interface RegistryBlock {
  number: number;
  timestamp: number;
  hash: string;
}

export type OrdersPerOwner = Map<Owner, Set<ConditionalOrder>>;

/**
 * Models the state between executions.
 * Contains a map of owners to conditional orders and the last time we sent an error.
 */
export class Registry {
  version = CONDITIONAL_ORDER_REGISTRY_VERSION;
  ownerOrders: OrdersPerOwner;
  storage: DBService;
  network: string;
  lastNotifiedError: Date | null;
  lastProcessedBlock: RegistryBlock | null;
  readonly logger = getLogger({ name: "Registry" });
  /**
   * Instantiates a registry.
   * @param ownerOrders What map to populate the registry with
   * @param storage storage service to use
   * @param network Which network the registry is for
   * @param lastNotifiedError The last time we sent an error
   * @param lastProcessedBlock The last block we processed
   */
  constructor(
    ownerOrders: OrdersPerOwner,
    storage: DBService,
    network: string,
    lastNotifiedError: Date | null,
    lastProcessedBlock: RegistryBlock | null
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
   * @returns The conditional orders that are in the registry
   */
  public static async dump(
    storage: DBService,
    network: string
  ): Promise<string> {
    const ownerOrders = await loadOwnerOrders(storage.getDB(), network);
    return JSON.stringify(
      ownerOrders ?? new Map(),
      (key, value) => {
        // Also redact inline payloads from local prototype databases.
        if (key === "aaveOrderAttempt" && value) {
          const { uid, validTo }: AaveOrderAttempt = value;
          return { uid, validTo };
        }
        return replacer(key, value);
      },
      2
    );
  }

  /**
   * Load the registry from storage.
   * @param storage to load the registry from
   * @param network that the registry is for
   * @param genesisBlockNumber the block number of the genesis block
   * @returns a registry instance
   */
  public static async load(
    storage: DBService,
    network: string,
    genesisBlockNumber: number
  ): Promise<Registry> {
    const db = storage.getDB();
    const storedOrders = await loadOwnerOrders(db, network);
    const savedError = await readOptional(
      db,
      LAST_NOTIFIED_ERROR_STORAGE_KEY,
      network
    );
    const savedBlock = await readOptional(
      db,
      LAST_PROCESSED_BLOCK_STORAGE_KEY,
      network
    );
    if (storedOrders === undefined && savedBlock !== undefined) {
      throw new Error(
        `Missing order registry for network ${network} (configured start: ${genesisBlockNumber})`
      );
    }

    const lastNotifiedError =
      savedError === undefined ? null : new Date(savedError);
    if (lastNotifiedError && Number.isNaN(lastNotifiedError.valueOf())) {
      throw new Error(`Invalid last notified error for network ${network}`);
    }
    const lastProcessedBlock: RegistryBlock | null =
      savedBlock === undefined ? null : JSON.parse(savedBlock);
    if (
      savedBlock !== undefined &&
      !Number.isSafeInteger(lastProcessedBlock?.number)
    ) {
      throw new Error(`Invalid saved block for network ${network}`);
    }
    const ownerOrders: OrdersPerOwner = storedOrders ?? new Map();
    await restoreAavePayloads(db, network, ownerOrders);

    // Return registry (on its latest version)
    metrics.activeOwnersTotal.labels(network).set(ownerOrders.size);
    metrics.activeOrdersTotal
      .labels(network)
      .set(getOrdersCountFromOrdersPerOwner(ownerOrders));

    return new Registry(
      ownerOrders,
      storage,
      network,
      lastNotifiedError,
      lastProcessedBlock
    );
  }

  get numOrders(): number {
    return getOrdersCountFromOrdersPerOwner(this.ownerOrders);
  }

  get numOwners(): number {
    return this.ownerOrders.size;
  }

  /**
   * Drop discrete orders that can no longer be placed, across every owner.
   * @param nowEpoch the chain timestamp to consider "now"
   * @returns the number of entries removed
   */
  public prune(nowEpoch: number): number {
    let pruned = 0;

    for (const conditionalOrders of this.ownerOrders.values()) {
      for (const conditionalOrder of conditionalOrders) {
        pruned += pruneExpiredOrders(conditionalOrder.orders, nowEpoch);
      }
    }

    return pruned;
  }

  public async write(): Promise<void> {
    const { orders, payloads } = this.serializeOrders();
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
        orders
      );

    // Older binaries can dump the order registry, so keep signatures in a private key.
    const payloadKey = getNetworkStorageKey(
      AAVE_ORDER_PAYLOADS_STORAGE_KEY,
      this.network
    );
    if (Object.keys(payloads).length) {
      batch.put(payloadKey, JSON.stringify(payloads));
    } else {
      batch.del(payloadKey);
    }

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
        JSON.stringify(this.lastProcessedBlock)
      );
    } else {
      batch.del(
        getNetworkStorageKey(LAST_PROCESSED_BLOCK_STORAGE_KEY, this.network)
      );
    }

    // Write all atomically
    await batch.write();

    this.logger.debug(
      `${this.network}@${this.lastProcessedBlock?.number}:v${this.version}${
        this.lastNotifiedError ? ":lastError_" + this.lastNotifiedError : ""
      } DB persisted`
    );
  }

  private serializeOrders() {
    const payloads: Record<string, OrderCreation> = {};
    const orders = JSON.stringify(this.ownerOrders, (key, value) => {
      if (key === "aaveOrderAttempt" && value) {
        const { uid, validTo, state, payload }: AaveOrderAttempt = value;
        if (state === "pending" && !payload) {
          throw new Error(`Missing payload for pending Aave order ${uid}`);
        }
        if (payload) payloads[uid] = payload;
        return { uid, validTo, state };
      }
      return replacer(key, value);
    });
    return { orders, payloads };
  }
}

function reviver(_key: any, value: any) {
  if (typeof value === "object" && value !== null) {
    if (value.dataType === "Map") {
      return new Map(value.value);
    } else if (value.dataType === "Set") {
      return new Set(value.value);
    }
  }
  return value;
}

function replacer(_key: any, value: any) {
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

async function readOptional(db: DBLevel, key: string, network: string) {
  try {
    return await db.get(getNetworkStorageKey(key, network));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "LEVEL_NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function loadOwnerOrders(
  db: DBLevel,
  network: string
): Promise<OrdersPerOwner | undefined> {
  const str = await readOptional(
    db,
    CONDITIONAL_ORDER_REGISTRY_STORAGE_KEY,
    network
  );
  if (str === undefined) return undefined;
  const version = Number(
    (await readOptional(db, CONDITIONAL_ORDER_REGISTRY_VERSION_KEY, network)) ??
      "1"
  );
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > CONDITIONAL_ORDER_REGISTRY_VERSION
  ) {
    throw new Error(`Invalid order registry version for network ${network}`);
  }
  const ordersPerOwner = parseConditionalOrders(str, version);

  const loadOwnerOrdersLogger = getLogger({ name: "loadOwnerOrders" });
  loadOwnerOrdersLogger.info(
    `Data size: ${str.length}`,
    `Owners: ${ordersPerOwner.size}`,
    `Total orders: ${getOrdersCountFromOrdersPerOwner(ordersPerOwner)}`,
    `Network: ${network}`
  );

  return ordersPerOwner;
}

async function restoreAavePayloads(
  db: DBLevel,
  network: string,
  ownerOrders: OrdersPerOwner
) {
  const stored = await readOptional(
    db,
    AAVE_ORDER_PAYLOADS_STORAGE_KEY,
    network
  );
  const payloads: Record<string, OrderCreation> = JSON.parse(stored ?? "{}");
  if (!payloads || typeof payloads !== "object" || Array.isArray(payloads)) {
    throw new Error(`Invalid saved Aave payloads for network ${network}`);
  }
  const pending = new Map(Object.entries(payloads));

  for (const orders of ownerOrders.values()) {
    for (const { aaveOrderAttempt: attempt } of orders) {
      if (!attempt) continue;
      const { uid, validTo, state } = attempt;
      if (
        attempt.payload !== undefined ||
        (state !== "pending" && state !== "lookup-only" && state !== "accepted")
      ) {
        throw new Error(`Unsupported saved state for Aave order ${uid}`);
      }
      const payload = pending.get(uid);
      if (state === "pending" && !payload) {
        throw new Error(`Missing saved payload for Aave order ${uid}`);
      }
      if (payload) {
        if (
          state === "accepted" ||
          payload.validTo !== validTo ||
          typeof payload.signature !== "string"
        ) {
          throw new Error(`Invalid saved payload for Aave order ${uid}`);
        }
        attempt.payload = payload;
        pending.delete(uid);
      }
    }
  }
  if (pending.size > 0)
    throw new Error(`Untracked Aave payloads for network ${network}`);
}

function parseConditionalOrders(
  serializedConditionalOrders: string,
  version: number
): OrdersPerOwner {
  const ownerOrders: Map<
    Owner,
    Set<Omit<ConditionalOrder, "id"> & { id?: string }>
  > = JSON.parse(serializedConditionalOrders, reviver);

  if (!(ownerOrders instanceof Map)) {
    throw new Error("Invalid order registry");
  }

  for (const orders of ownerOrders.values()) {
    if (!(orders instanceof Set)) throw new Error("Invalid order registry");
    // The conditional order id was added in version 2
    if (version < 2) {
      for (const order of orders.values()) {
        if (!order.id) {
          order.id = ConditionalOrderSdk.leafToId(order.params);
        }
      }
    }
  }

  return ownerOrders as OrdersPerOwner;
}

function getOrdersCountFromOrdersPerOwner(
  ordersPerOwner: OrdersPerOwner
): number {
  let ordersCount = 0;

  for (const orders of ordersPerOwner.values()) {
    ordersCount += orders.size;
  }

  return ordersCount;
}
