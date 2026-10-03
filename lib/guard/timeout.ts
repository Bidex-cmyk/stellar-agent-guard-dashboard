export class DashboardReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardReadError";
  }
}

/**
 * Wraps an asynchronous read operation with a timeout.
 *
 * Uses an AbortController internally to trigger the timeout. The abort listener
 * is guaranteed to be cleaned up in a `finally` block to prevent memory leaks
 * even if the operation succeeds or fails before the timeout.
 *
 * @param operation The operation to execute. It receives the AbortSignal, which it may pass to underlying fetch calls if supported.
 * @param timeoutMs The timeout in milliseconds. Defaults to 10000 (10s) based on RPC norms and matching the SDK default.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = 10000,
): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  let rejectPromise!: (reason?: any) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });

  const onAbort = () => {
    rejectPromise(new DashboardReadError(`Read timed out after ${timeoutMs}ms`));
  };

  controller.signal.addEventListener("abort", onAbort);

  const opPromise = operation(controller.signal);
  // Prevent unhandled rejections if the operation fails after the timeout fires
  opPromise.catch(() => {});

  try {
    return await Promise.race([opPromise, timeoutPromise]);
  } finally {
    clearTimeout(id);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
