import { providers } from "ethers";
import {
  ChainSync,
  RPC_TIMEOUT_MS,
  WARM_UP_RPC_TIMEOUT_MS,
  getEventPollingRange,
  isReorg,
  watchdogSyncState,
} from "./chain";

const block = (
  number: number,
  hash: string,
  parentHash = ""
): providers.Block => ({ number, hash, parentHash } as providers.Block);

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

describe("getEventPollingRange", () => {
  it.each([
    [10, 11, [11, 11]],
    [10, 13, [11, 13]],
    [10, 8, [8, 8]],
  ])(
    "returns the event range after block %i for incoming block %i",
    (previousBlockNumber, blockNumber, expected) => {
      expect(getEventPollingRange(previousBlockNumber, blockNumber)).toEqual(
        expected
      );
    }
  );
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
