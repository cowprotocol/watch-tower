export interface RetryOptions {
  /** Total attempts, including the first one */
  attempts: number;
  /** Delay before the first retry; doubles on each subsequent retry */
  baseDelayMs: number;
  /** Called before sleeping, so the caller can log the upcoming retry */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Retry an operation with exponential backoff, rethrowing the final error if
 * every attempt fails.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { attempts, baseDelayMs, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        break;
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(attempt, error, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
