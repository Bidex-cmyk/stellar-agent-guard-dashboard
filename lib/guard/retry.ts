import { rpc } from "@stellar/stellar-sdk";

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;

  let attempt = 0;
  while (true) {
    try {
      const result = await operation();
      return result;
    } catch (error: any) {
      if (attempt >= maxRetries) {
        throw error;
      }

      const isRetryable =
        error instanceof RetryableError ||
        error.message?.includes("TIMEOUT") ||
        error.message?.includes("TRY_AGAIN_LATER") ||
        error.message?.includes("NOT_FOUND") ||
        error.message?.includes("429");

      if (!isRetryable) {
        throw error;
      }

      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.random() * delay;
      await new Promise((resolve) => setTimeout(resolve, jitter));
      attempt++;
    }
  }
}
