import { TimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  it("resolves with the value when the operation completes in time", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 50, "post order")
    ).resolves.toBe("ok");
  });

  it("propagates the original rejection rather than masking it", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("api down")), 50, "post order")
    ).rejects.toThrow("api down");
  });

  it("rejects with a TimeoutError when the operation hangs", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, "post order")
    ).rejects.toThrow(TimeoutError);
  });

  it("names the operation in the timeout message", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, "post order")
    ).rejects.toThrow("post order timed out after 10ms");
  });

  it("clears its timer instead of holding the event loop open", async () => {
    // `getActiveResourcesInfo` exists from Node 17 but isn't in @types/node 18
    const nodeProcess = process as unknown as {
      getActiveResourcesInfo(): string[];
    };
    const pendingTimers = () =>
      nodeProcess.getActiveResourcesInfo().filter((r) => r === "Timeout")
        .length;

    const before = pendingTimers();
    await withTimeout(Promise.resolve("ok"), 60_000, "post order");

    expect(pendingTimers()).toBe(before);
  });
});
