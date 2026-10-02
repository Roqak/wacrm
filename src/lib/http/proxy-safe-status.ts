/**
 * The status a dashboard API route should answer with when it wants to
 * report an upstream (Meta / AI provider) failure.
 *
 * Cloudflare — in front of tunnel-hosted deploys — swaps any origin
 * 502/504 body for its own HTML error page, so a 502 carrying Meta's
 * rejection reached the browser as "HTTP 502" or "Received a non-JSON
 * … response" and the real reason was lost. 422 passes through
 * untouched and still reads as "understood but refused". The v1 API
 * keeps its documented 502s.
 */
export function proxySafeStatus(status: number): number {
  return status === 502 || status === 504 ? 422 : status
}
