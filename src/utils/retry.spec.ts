import { withRetry } from "./retry";

const opts = (onRetry?: (attempt: number, e: unknown, ms: number) => void) => ({
  attempts: 4,
  baseDelayMs: 1,
  onRetry,
});

describe("withRetry", () => {
  it("returns the result without retrying when the operation succeeds", async () => {
    const operation = jest.fn(async () => "ok");

    await expect(withRetry(operation, opts())).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries until the operation succeeds", async () => {
    let calls = 0;
    const operation = jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("rpc flake");
      return "ok";
    });

    await expect(withRetry(operation, opts())).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows the final error once attempts are exhausted", async () => {
    const operation = jest.fn(async () => {
      throw new Error("rpc down");
    });

    await expect(withRetry(operation, opts())).rejects.toThrow("rpc down");
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const operation = async () => {
      throw new Error("rpc down");
    };

    await expect(
      withRetry(
        operation,
        opts((_a, _e, ms) => delays.push(ms))
      )
    ).rejects.toThrow("rpc down");

    // 3 retries after the initial attempt, doubling each time
    expect(delays).toEqual([1, 2, 4]);
  });
});
