import {
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
  const conditionalOrder = (orders: string[]): ConditionalOrder =>
    ({
      id: "0x01",
      tx: "0x02",
      proof: null,
      composableCow: "0x03",
      orders: new Map(orders.map((uid) => [uid, OrderStatus.SUBMITTED])),
    } as unknown as ConditionalOrder);

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
});

describe("Registry.write", () => {
  type FakeBatch = {
    put: jest.Mock;
    del: jest.Mock;
    write: jest.Mock;
  };

  const fakeBatch = (): FakeBatch => {
    const batch: FakeBatch = {
      put: jest.fn(() => batch),
      del: jest.fn(() => batch),
      write: jest.fn(async () => undefined),
    };
    return batch;
  };

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
});
