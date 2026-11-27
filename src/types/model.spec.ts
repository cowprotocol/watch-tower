import { OrderKind, SigningScheme } from "@cowprotocol/sdk-order-book";

import {
  AaveOrderAttempt,
  ConditionalOrder,
  OrderStatus,
  OrderUid,
  OrdersPerOwner,
  Registry,
  pruneExpiredOrders,
} from "./model";
import { DBService } from "../services";
import { initLogging } from "../utils";

initLogging({});

/**
 * Build a GPv2 order uid: `keccak256(orderDigest) || owner || validTo`,
 * i.e. 32 bytes of digest, 20 bytes of owner and 4 bytes of `validTo`.
 */
const orderUid = (validTo: number, digestByte = "aa"): string =>
  "0x" +
  digestByte.repeat(32) +
  "bb".repeat(20) +
  validTo.toString(16).padStart(8, "0");

const NOW = 1_784_857_003;

const conditionalOrder = (orders: string[]): ConditionalOrder => ({
  id: "0x01",
  tx: "0x02",
  proof: null,
  composableCow: "0x03",
  params: { handler: "0x04", salt: "0x05", staticInput: "0x" },
  orders: new Map(orders.map((uid) => [uid, OrderStatus.SUBMITTED])),
});

describe("pruneExpiredOrders", () => {
  const ordersWith = (uids: string[]): Map<OrderUid, OrderStatus> =>
    new Map(uids.map((uid) => [uid, OrderStatus.SUBMITTED]));

  it("removes orders whose validTo has already passed", () => {
    const expired = orderUid(NOW - 1);
    const orders = ordersWith([expired]);

    expect(pruneExpiredOrders(orders, NOW)).toBe(1);
    expect(orders.has(expired)).toBe(false);
  });

  it("keeps orders that are still valid", () => {
    const live = orderUid(NOW + 1);
    const orders = ordersWith([live]);

    expect(pruneExpiredOrders(orders, NOW)).toBe(0);
    expect(orders.has(live)).toBe(true);
  });

  it("keeps uids it cannot parse rather than dropping unknown state", () => {
    const malformed = "0xdeadbeef";
    const orders = ordersWith([malformed]);

    expect(pruneExpiredOrders(orders, NOW)).toBe(0);
    expect(orders.has(malformed)).toBe(true);
  });

  it("keeps a full-length uid whose validTo is not valid hex", () => {
    // `parseInt` stops at the first invalid character rather than returning
    // NaN, so a truncated parse would look long expired and be pruned
    const malformed = "0x" + "aa".repeat(32) + "bb".repeat(20) + "6a6429az";
    const orders = ordersWith([malformed]);

    expect(pruneExpiredOrders(orders, NOW)).toBe(0);
    expect(orders.has(malformed)).toBe(true);
  });

  it("prunes only the expired entries of a mixed registry", () => {
    const live = orderUid(NOW + 600, "11");
    const orders = ordersWith([
      orderUid(NOW - 600, "22"),
      live,
      orderUid(NOW - 1, "33"),
    ]);

    expect(pruneExpiredOrders(orders, NOW)).toBe(2);
    expect([...orders.keys()]).toEqual([live]);
  });
});

describe("Registry.prune", () => {
  const registryWith = (owners: ConditionalOrder[][]): Registry =>
    new Registry(
      new Map(
        owners.map((orders, i) => [`0xowner${i}`, new Set(orders)])
      ) as OrdersPerOwner,
      undefined as unknown as DBService,
      "1",
      null,
      null
    );

  it("prunes expired discrete orders across every owner", () => {
    const live = orderUid(NOW + 600, "11");
    const registry = registryWith([
      [conditionalOrder([orderUid(NOW - 600, "22"), live])],
      [conditionalOrder([orderUid(NOW - 1, "33")])],
    ]);

    expect(registry.prune(NOW)).toBe(2);

    const remaining = [...registry.ownerOrders.values()]
      .flatMap((orders) => [...orders])
      .flatMap((order) => [...order.orders.keys()]);
    expect(remaining).toEqual([live]);
  });

  it("retains tracking for Aave attempts after order expiry", () => {
    const uid = orderUid(NOW - 1);
    const aaveOrder = {
      ...conditionalOrder([uid]),
      aaveOrderAttempt: { uid, validTo: NOW - 1, state: "accepted" as const },
    };
    const registry = registryWith([[aaveOrder]]);

    expect(registry.prune(NOW)).toBe(1);
    expect(aaveOrder.aaveOrderAttempt.uid).toBe(uid);
  });
});

describe("Registry.write", () => {
  type FakeBatch = {
    put: jest.Mock;
    del: jest.Mock;
    write: jest.Mock;
  };

  const fakeBatch = (stored = new Map<string, string>()): FakeBatch => {
    const writes = new Map<string, string | undefined>();
    const batch: FakeBatch = {
      put: jest.fn((key: string, value: string) => {
        writes.set(key, value);
        return batch;
      }),
      del: jest.fn((key: string) => {
        writes.set(key, undefined);
        return batch;
      }),
      write: jest.fn(async () => {
        for (const [key, value] of writes) {
          if (value === undefined) stored.delete(key);
          else stored.set(key, value);
        }
      }),
    };
    return batch;
  };

  function fakeStorage(stored = new Map<string, string>()) {
    const get = jest.fn(async (key: string) => {
      const value = stored.get(key);
      if (value === undefined) {
        throw Object.assign(new Error("Missing key"), {
          code: "LEVEL_NOT_FOUND",
        });
      }
      return value;
    });
    const storage = {
      getDB: () => ({ batch: () => fakeBatch(stored), get }),
    } as unknown as DBService;

    return { storage, stored, get };
  }

  // `write()` is called on every CHUNK_SIZE orders, so it must stay cheap.
  // Pruning is a whole-registry scan and belongs to the once-per-block caller.
  it("does not prune, leaving that to the once-per-block caller", async () => {
    const batch = fakeBatch();
    const storage = {
      getDB: () => ({ batch: () => batch }),
    } as unknown as DBService;

    const expired = orderUid(NOW - 1, "44");
    const live = orderUid(NOW + 600, "55");
    const order = {
      orders: new Map([
        [expired, OrderStatus.SUBMITTED],
        [live, OrderStatus.SUBMITTED],
      ]),
    } as unknown as ConditionalOrder;

    const registry = new Registry(
      new Map([["0xowner", new Set([order])]]) as OrdersPerOwner,
      storage,
      "1",
      null,
      { number: 1, timestamp: NOW, hash: "0x0" }
    );

    await registry.write();

    expect([...order.orders.keys()]).toEqual([expired, live]);
  });

  it("persists the signed payload privately and restores it after a restart", async () => {
    const { storage, stored } = fakeStorage();
    const attempt: AaveOrderAttempt = {
      uid: orderUid(NOW + 600),
      validTo: NOW + 600,
      state: "pending",
      payload: {
        sellToken: "0x01",
        buyToken: "0x02",
        sellAmount: "100",
        buyAmount: "50",
        feeAmount: "0",
        validTo: NOW + 600,
        appData: "{}",
        quoteId: 42,
        kind: OrderKind.SELL,
        partiallyFillable: false,
        signingScheme: SigningScheme.EIP1271,
        signature: "0x1234",
      },
    };
    const owner = "0xowner";
    const order: ConditionalOrder = {
      ...conditionalOrder([]),
      aaveOrderAttempt: attempt,
    };
    const registry = new Registry(
      new Map([[owner, new Set([order])]]),
      storage,
      "1",
      null,
      null
    );

    await registry.write();
    const reloaded = await Registry.load(storage, "1", 1);

    expect(reloaded.ownerOrders.get(owner)).toEqual(new Set([order]));
    const dump = await Registry.dump(storage, "1");
    expect(dump).toContain(attempt.uid);
    expect(dump).not.toContain('"payload"');
    expect(dump).not.toContain('"signature"');
    expect(stored.get("CONDITIONAL_ORDER_REGISTRY_1")).not.toContain(
      '"signature"'
    );
    expect(stored.get("AAVE_ORDER_PAYLOADS_1")).toContain("0x1234");

    stored.delete("AAVE_ORDER_PAYLOADS_1");
    await expect(Registry.load(storage, "1", 1)).rejects.toThrow(
      "Missing saved payload"
    );

    attempt.state = "lookup-only";
    await registry.write();
    expect(
      (await Registry.load(storage, "1", 1)).ownerOrders.get(owner)
    ).toEqual(new Set([order]));

    attempt.state = "accepted";
    delete attempt.payload;
    await registry.write();
    expect(stored.has("AAVE_ORDER_PAYLOADS_1")).toBe(false);
  });

  it("starts from an empty registry when all state is genuinely missing", async () => {
    const { storage } = fakeStorage();
    await expect(Registry.load(storage, "1", 1)).resolves.toMatchObject({
      ownerOrders: new Map(),
      lastProcessedBlock: null,
    });
  });

  it("fails to load when the database returns a read error", async () => {
    const { storage, get } = fakeStorage();
    get.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(Registry.load(storage, "1", 1)).rejects.toThrow(
      "Storage unavailable"
    );
  });

  it("fails to load a cursor without the corresponding registry", async () => {
    const { storage, stored } = fakeStorage();
    stored.set(
      "LAST_PROCESSED_BLOCK_1",
      JSON.stringify({ number: 1, timestamp: NOW, hash: "0x0" })
    );

    await expect(Registry.load(storage, "1", 1)).rejects.toThrow(
      "Missing order registry"
    );
  });

  it("fails to load a malformed registry", async () => {
    const { storage, stored } = fakeStorage();
    stored.set("CONDITIONAL_ORDER_REGISTRY_1", "invalid JSON");
    await expect(Registry.load(storage, "1", 1)).rejects.toThrow(SyntaxError);
  });
});
