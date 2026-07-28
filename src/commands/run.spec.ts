import { initLogging } from "../utils";
import { WarmUpChain, warmUpChains } from "./run";

// These tests deliberately drive the failure path, which logs errors by design
initLogging({ logLevel: "SILENT" });

/** Tiny backoff so the tests don't wait out the production delays */
const backoff = { attempts: 3, baseDelayMs: 1, maxDelayMs: 4 };

const chain = (
  chainId: number,
  warmUp: (oneShot?: boolean) => Promise<unknown>
): WarmUpChain & { markUnhealthy: jest.Mock } => ({
  chainId,
  warmUp: jest.fn(warmUp),
  markUnhealthy: jest.fn(),
});

const healthy = (chainId: number, onWarmUp?: () => void) =>
  chain(chainId, async () => {
    // Resolve on a later tick so a sibling's synchronous rejection has every
    // chance to abort us before we finish.
    await new Promise((resolve) => setTimeout(resolve, 5));
    onWarmUp?.();
  });

const broken = (chainId: number) =>
  chain(chainId, async () => {
    throw new Error("could not detect network");
  });

describe("warmUpChains", () => {
  it("returns a zero exit code once every chain has warmed up", async () => {
    const chains = [healthy(1), healthy(100), healthy(8453)];

    await expect(warmUpChains(chains, { backoff })).resolves.toBe(0);
    chains.forEach((c) => {
      expect(c.warmUp).toHaveBeenCalledTimes(1);
      expect(c.markUnhealthy).not.toHaveBeenCalled();
    });
  });

  it("passes the one-shot flag through to each chain", async () => {
    const chains = [healthy(1), healthy(100)];

    await warmUpChains(chains, { oneShot: true, backoff });

    chains.forEach((c) => expect(c.warmUp).toHaveBeenCalledWith(true));
  });

  it("does not reject when a chain exhausts its warm-up retries", async () => {
    // Regression: `Promise.all` used to propagate this rejection out of
    // `run()`, which then exited the process and took every healthy chain
    // down with the one broken RPC.
    const chains = [broken(1), healthy(100), healthy(8453)];

    await expect(warmUpChains(chains, { backoff })).resolves.not.toThrow();
  });

  it("still warms up healthy chains when a sibling chain fails", async () => {
    const warmedUp: number[] = [];
    const chains = [
      broken(1),
      healthy(100, () => warmedUp.push(100)),
      healthy(8453, () => warmedUp.push(8453)),
    ];

    await warmUpChains(chains, { backoff });

    // Both healthy chains ran to completion, and were awaited - the broken
    // chain neither cancelled them nor let `warmUpChains` resolve early.
    expect(warmedUp).toEqual([100, 8453]);
    expect(chains[1].warmUp).toHaveBeenCalledTimes(1);
    expect(chains[2].warmUp).toHaveBeenCalledTimes(1);
  });

  it("only marks the failing chain unhealthy", async () => {
    const chains = [broken(1), healthy(100), healthy(8453)];

    await warmUpChains(chains, { backoff });

    expect(chains[0].markUnhealthy).toHaveBeenCalled();
    expect(chains[1].markUnhealthy).not.toHaveBeenCalled();
    expect(chains[2].markUnhealthy).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit code when a chain gives up", async () => {
    // The failure is isolated, but it must not be silent: a run where nothing
    // is being watched has to exit non-zero so the pod is restarted.
    await expect(
      warmUpChains([broken(1), healthy(100)], { backoff })
    ).resolves.toBe(1);
  });

  it("retries a chain whose RPC is briefly unavailable", async () => {
    let attempts = 0;
    const flaky = chain(1, async () => {
      attempts++;
      if (attempts < backoff.attempts) throw new Error("rate limited");
    });

    await expect(
      warmUpChains([flaky, healthy(100)], { backoff })
    ).resolves.toBe(0);
    expect(attempts).toBe(backoff.attempts);
    expect(flaky.markUnhealthy).not.toHaveBeenCalled();
  });

  it("gives up on a chain after a bounded number of attempts", async () => {
    const chains = [broken(1)];

    await warmUpChains(chains, { backoff });

    expect(chains[0].warmUp).toHaveBeenCalledTimes(backoff.attempts);
  });

  it("isolates a chain that rejects with a non-error value", async () => {
    const weird = chain(1, async () => {
      throw "boom"; // eslint-disable-line no-throw-literal
    });

    await expect(
      warmUpChains([weird, healthy(100)], { backoff })
    ).resolves.toBe(1);
    expect(weird.markUnhealthy).toHaveBeenCalled();
  });

  it("keeps siblings alive when marking a chain unhealthy itself throws", async () => {
    const chains = [broken(1), healthy(100)];
    chains[0].markUnhealthy.mockImplementation(() => {
      throw new Error("metrics registry blew up");
    });

    await expect(warmUpChains(chains, { backoff })).resolves.toBe(1);
    expect(chains[1].warmUp).toHaveBeenCalledTimes(1);
  });
});
