export function rateLimitBackoff() {
  // exponential backoff for rate-limited RPC queries
  return { delay: 1000 };
}
