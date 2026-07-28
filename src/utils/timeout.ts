/** Thrown when an operation wrapped in `withTimeout` does not settle in time */
export class TimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Bound how long an operation may take.
 *
 * Neither the orderbook SDK nor the ethers providers apply a request timeout,
 * so a hung socket blocks for however long the OS takes to give up on the TCP
 * connection - minutes. Block processing is serialised, so a single wedged
 * request stalls the whole chain watcher behind it.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(operation, timeoutMs)),
      timeoutMs
    );
  });

  // `finally` clears the timer on both paths, so a fast operation doesn't
  // leave a pending timer holding the event loop open.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
