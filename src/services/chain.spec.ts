import { setGlobalAdapter } from "@cowprotocol/cow-sdk";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { providers, utils } from "ethers";
import * as polling from "../domain/polling";
import { policy } from "../domain/polling/filtering";
import { processNewOrderEvent } from "../domain/events";
import { ComposableCoW__factory } from "../types";
import { initLogging } from "../utils";
import {
  ChainContext,
  ChainSync,
  RPC_TIMEOUT_MS,
  WARM_UP_RPC_TIMEOUT_MS,
  isReorg,
  pollContractForEvents,
  watchdogSyncState,
} from "./chain";

initLogging({ logLevel: "ERROR" });

const block = (
  number: number,
  hash: string,
  parentHash = ""
): providers.Block =>
  ({ number, hash, parentHash, timestamp: number * 12 } as providers.Block);

describe("isReorg", () => {
  const provider = {
    getBlock: jest.fn(),
  } as unknown as providers.Provider;

  beforeEach(() => jest.clearAllMocks());

  it("accepts a consecutive block with the expected parent", async () => {
    await expect(
      isReorg(provider, block(10, "old"), block(11, "new", "old"))
    ).resolves.toBe(false);
  });

  it("detects a consecutive block with a different parent", async () => {
    await expect(
      isReorg(provider, block(10, "old"), block(11, "new", "fork"))
    ).resolves.toBe(true);
  });

  it("detects a lower replacement head", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "fork"));

    await expect(
      isReorg(provider, block(10, "old"), block(8, "fork"))
    ).resolves.toBe(true);
    expect(provider.getBlock).toHaveBeenCalledWith(10);
  });

  it("accepts a delayed lower block when the previous block remains canonical", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "old"));

    await expect(
      isReorg(provider, block(10, "old"), block(8, "canonical"))
    ).resolves.toBe(false);
  });

  it("accepts a block gap when the previous block remains canonical", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "old"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).resolves.toBe(false);
    expect(provider.getBlock).toHaveBeenCalledWith(10);
  });

  it("detects a block gap when the previous block is no longer canonical", async () => {
    provider.getBlock = jest.fn().mockResolvedValue(block(10, "fork"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).resolves.toBe(true);
  });

  it("propagates gap verification errors to the subscription handler", async () => {
    provider.getBlock = jest.fn().mockRejectedValue(new Error("RPC failed"));

    await expect(
      isReorg(provider, block(10, "old"), block(13, "new"))
    ).rejects.toThrow("RPC failed");
  });
});

const owner = utils.getAddress("0xabcd111111111111111111111111111111111111");
const handler = "0x2222222222222222222222222222222222222222";
const registrationLog: providers.Log = {
  address: "0x4444444444444444444444444444444444444444",
  blockNumber: 12,
  blockHash: utils.id("block"),
  transactionIndex: 0,
  transactionHash: utils.id("arm"),
  logIndex: 0,
  removed: false,
  ...ComposableCoW__factory.createInterface().encodeEventLog(
    "ConditionalOrderCreated",
    [owner, { handler, salt: utils.id("test rule"), staticInput: "0x1234" }]
  ),
};

it("filters owner topics at the RPC and returns the original registration log", async () => {
  const provider = new providers.JsonRpcProvider();
  const getLogs = jest.spyOn(provider, "getLogs").mockResolvedValue([
    registrationLog,
    { ...registrationLog, removed: true },
    {
      ...registrationLog,
      topics: [registrationLog.topics[0], utils.hexZeroPad(handler, 32)],
    },
  ]);
  const addresses = [owner.toLowerCase()];

  await expect(
    pollContractForEvents(10, 12, { provider, addresses })
  ).resolves.toEqual([registrationLog]);
  expect(getLogs).toHaveBeenCalledWith({
    fromBlock: 10,
    toBlock: 12,
    topics: [registrationLog.topics[0], [utils.hexZeroPad(addresses[0], 32)]],
  });
  await expect(
    pollContractForEvents(10, 12, { provider, addresses: [] })
  ).resolves.toEqual([]);
  expect(getLogs).toHaveBeenCalledTimes(1);
});

it("keeps the canonical registration when another registry has the same order parameters", async () => {
  setGlobalAdapter(
    new EthersV5Adapter({ provider: new providers.StaticJsonRpcProvider() })
  );
  const canonical = "0x3333333333333333333333333333333333333333";
  const ownerOrders = new Map();
  const context = {
    chainId: 1,
    aaveProtectionHandler: handler,
    filterPolicy: new policy.FilterPolicy({
      defaultAction: "DROP",
      owners: { [owner.toLowerCase()]: "ACCEPT" },
    }),
    contract: { address: canonical },
    registry: { network: "1", ownerOrders, write: jest.fn() },
  } as unknown as ChainContext;

  await processNewOrderEvent(context, registrationLog);
  expect(ownerOrders.size).toBe(0);
  await processNewOrderEvent(context, {
    ...registrationLog,
    address: canonical,
  });

  expect([...ownerOrders.get(owner)]).toEqual([
    expect.objectContaining({ composableCow: canonical }),
  ]);
});

describe("warm-up registrations", () => {
  function context(
    head: providers.Block,
    lastProcessedBlock = block(10, "canonical", "parent"),
    provider: object = {}
  ) {
    return Object.assign(Object.create(ChainContext.prototype), {
      provider: Object.assign(new providers.StaticJsonRpcProvider(), {
        getBlock: jest.fn(async (tag) =>
          tag === lastProcessedBlock.number ? lastProcessedBlock : head
        ),
        getLogs: jest.fn().mockResolvedValue([]),
        ...provider,
      }),
      chainId: 1,
      deploymentBlock: 8,
      pageSize: 0,
      processEveryNumBlocks: 1,
      sync: ChainSync.SYNCING,
      registry: { lastProcessedBlock, write: jest.fn() },
    }) as ChainContext;
  }

  beforeEach(() => {
    jest.spyOn(polling, "checkForAndPlaceOrder").mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("pins the event scan and checkpoint and polls loaded rules in one-shot mode", async () => {
    const head = block(11, "tip", "canonical");
    const chain = context(head);

    await chain.warmUp(true);

    expect(chain.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 11, toBlock: 11 })
    );
    expect(chain.registry.lastProcessedBlock).toMatchObject({
      number: 11,
      hash: "tip",
    });
    expect(polling.checkForAndPlaceOrder).toHaveBeenCalledWith(chain, head);
  });

  it("indexes each live catch-up page and polls only at the head cadence", async () => {
    const at = (n: number) => block(n, `block-${n}`, `block-${n - 1}`);
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const on = jest.fn();
    const getLogs = jest.fn().mockResolvedValue([]);
    const chain = context(at(10), at(10), {
      getBlock: jest.fn(async (tag) => at(tag === "latest" ? 10 : tag)),
      getLogs,
      on,
    });
    Object.assign(chain, { pageSize: 1, processEveryNumBlocks: 2 });
    jest.useFakeTimers({ doNotFake: ["performance", "setImmediate"] });

    try {
      void chain.warmUp();
      await flush();
      const [, receiveBlock] = on.mock.calls[0];
      jest.mocked(polling.checkForAndPlaceOrder).mockClear();
      receiveBlock(13);
      await flush();

      expect(
        getLogs.mock.calls.map(([range]) => [range.fromBlock, range.toBlock])
      ).toEqual([
        [11, 11],
        [12, 12],
        [13, 13],
      ]);
      expect(chain.registry.lastProcessedBlock?.number).toBe(13);
      expect(polling.checkForAndPlaceOrder).not.toHaveBeenCalled();

      receiveBlock(14);
      await flush();
      expect(polling.checkForAndPlaceOrder).toHaveBeenCalledTimes(1);
      expect(polling.checkForAndPlaceOrder).toHaveBeenCalledWith(chain, at(14));
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the checkpoint if it changes during a forward page scan", async () => {
    const previous = block(10, "old", "parent");
    const replacement = block(10, "new", "parent");
    const head = block(12, "tip", "block-11");
    let switched = false;
    const chain = context(head, previous, {
      getBlock: jest.fn(async (id) =>
        id === 10 ? (switched ? replacement : previous) : head
      ),
      getLogs: jest.fn(async () => {
        switched = true;
        return [];
      }),
    });

    await expect(chain.warmUp(true)).rejects.toThrow(
      "Checkpoint block 10 changed"
    );
    expect(chain.registry.lastProcessedBlock).toBe(previous);
    expect(polling.checkForAndPlaceOrder).not.toHaveBeenCalled();
  });

  it("keeps the previous checkpoint when saving the new one fails", async () => {
    const previous = block(10, "canonical", "parent");
    const head = block(11, "tip", "canonical");
    const chain = context(head, previous);
    jest
      .spyOn(chain.registry, "write")
      .mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(chain.warmUp(true)).rejects.toThrow("storage unavailable");
    expect(chain.registry.lastProcessedBlock).toBe(previous);
  });

  it("rescans from the common ancestor of a replaced checkpoint", async () => {
    const ancestor = block(9, "parent", "earlier");
    const oldBlock = block(10, "old", "parent");
    const newBlock = block(10, "new", "parent");
    const head = block(11, "tip", "new");
    const blocks: Record<string, providers.Block> = {
      9: ancestor,
      10: newBlock,
      parent: ancestor,
      old: oldBlock,
    };
    const chain = context(head, oldBlock, {
      getBlock: jest.fn(async (id: string | number) => blocks[id] ?? head),
    });

    await chain.warmUp(true);

    expect(chain.provider.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 10, toBlock: 11 })
    );
  });
});

describe("watchdogSyncState", () => {
  const WATCHDOG_TIMEOUT = 300;

  it("reports UNKNOWN once the timeout has elapsed without a processed block", () => {
    expect(watchdogSyncState(WATCHDOG_TIMEOUT, WATCHDOG_TIMEOUT)).toBe(
      ChainSync.UNKNOWN
    );
  });

  it("recovers to IN_SYNC once blocks are being processed again", () => {
    expect(watchdogSyncState(WATCHDOG_TIMEOUT - 1, WATCHDOG_TIMEOUT)).toBe(
      ChainSync.IN_SYNC
    );
  });
});

describe("warm-up RPC bounds", () => {
  it("allows a warm-up call far longer than a block-path call", () => {
    // Warm-up pages over thousands of blocks with no watchdog running, so a
    // slow backfill must be able to finish. The block path is serialised
    // behind a watchdog and has to fail fast instead.
    expect(WARM_UP_RPC_TIMEOUT_MS).toBeGreaterThan(RPC_TIMEOUT_MS);
  });
});
