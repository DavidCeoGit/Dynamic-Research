/**
 * S52 Phase #1 — per-IP token bucket rate limit for unauth public API routes.
 *
 * Closes the worst-case unauth-Anthropic exposure surfaced by the S51
 * health audit (Documentation/review-2026-05-24.md §5): two unauth routes
 * (POST /api/queue/extract-context + POST /api/queue/generate-questions)
 * had no `maxOutputTokens` and no rate limit, exposing up to ~$5K/day at
 * 10 req/s × ~2k tokens. Token cap closes most of the burn; this limiter
 * closes the request-volume vector.
 *
 * S181: also used by the OTP verify Server Action (login/actions.ts:
 * verifyEmailOtp) as brute-force defense-in-depth. Server Actions have no
 * Request object, so clientIp() was split into clientIpFromHeaders() (takes any
 * { get(name) } header bag — a Headers OR next/headers ReadonlyHeaders) with
 * clientIp(request) delegating to it. Single source for the IP-extraction rule.
 *
 * SCOPE + LIMITATIONS (intentional, documented for the audit trail):
 *
 *   1. In-memory storage. State lives in the Vercel serverless function
 *      instance's heap, scoped per-instance. State is LOST on cold start
 *      and is NOT shared across regions or concurrent function instances.
 *      For Dynamic Research's current soft-launch traffic this is fine
 *      (a sustained-flood attacker hits the cap on the worst-case
 *      multiplied-by-instance-count, which is still much smaller than
 *      the unbounded baseline). For OTP-verify brute force this is a
 *      SECONDARY speed-bump; the PRIMARY control is Supabase-side and
 *      per-TOKEN (single-use codes + short expiry), not this limiter.
 *
 *   2. The intended replacement is @upstash/ratelimit + Upstash Redis
 *      (S52 follow-on if usage scales). The interface here is
 *      deliberately compatible: a single async `checkRateLimit(ip)`
 *      call that returns { allowed, retryAfterSec, remaining }.
 *      Drop-in swap when traffic justifies the Redis dependency.
 *
 *   3. IP source. On Vercel, `x-forwarded-for` is OVERWRITTEN by the platform
 *      with the true client IP and client-supplied values are NOT forwarded
 *      (Vercel does this specifically to prevent IP spoofing — see
 *      vercel.com/docs/headers/request-headers), so the leftmost entry is the
 *      trusted client IP and CANNOT be spoofed or rotated by a client. `x-real-ip`
 *      is the documented fallback (Vercel sets it identical to x-forwarded-for);
 *      it is only reached here when x-forwarded-for is absent (e.g. local /
 *      non-Vercel dev, where spoofing is not the threat model). A fully missing
 *      IP yields the single shared "anon" bucket (safest fail-mode — does not let
 *      a malformed-header attacker dodge the limiter).
 *
 *   4. Bucket size + refill rate are conservative: 20 tokens, refill 1
 *      token per 180 seconds (= 20 req/hour sustained, with burst
 *      capacity for the 3-step form wizard which fires ~2-3 calls per
 *      submission). Tunable via env vars below.
 */

const BUCKET_SIZE = parseIntEnv("RATE_LIMIT_BUCKET_SIZE", 20);
const REFILL_INTERVAL_MS = parseIntEnv("RATE_LIMIT_REFILL_MS", 180_000);

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

/**
 * Extract a stable client IP from a header bag. On Vercel the leftmost
 * x-forwarded-for entry is the platform-set, spoof-proof client IP (Vercel
 * overwrites the header). x-real-ip is the Vercel-provided fallback (identical to
 * x-forwarded-for) and is only reached off-Vercel/local; final fallback "anon" is
 * a single shared bucket (safe fail). Accepts anything with a
 * `get(name): string | null` method, so it works with both a WHATWG `Headers`
 * (route handlers, via clientIp) and a next/headers `ReadonlyHeaders` (Server
 * Actions / Server Components).
 */
export function clientIpFromHeaders(h: {
  get(name: string): string | null;
}): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for can be comma-separated (client, proxy1, proxy2...).
    // On Vercel the leftmost entry is the platform-overwritten client IP.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = h.get("x-real-ip");
  if (xri) return xri.trim();
  return "anon";
}

/**
 * Extract a stable client IP from a Request. Vercel terminates TLS and sets
 * x-forwarded-for. Delegates to clientIpFromHeaders so the rule is single-source.
 */
export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/**
 * Check + decrement the bucket for the given client IP. Returns whether
 * the request is allowed plus headers' worth of state for 429 responses.
 *
 * Async signature so a future swap to @upstash/ratelimit (which is async)
 * is a no-op at the call site.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket) {
    bucket = { tokens: BUCKET_SIZE, lastRefill: now };
    buckets.set(ip, bucket);
  }

  // Refill: add one token per REFILL_INTERVAL_MS elapsed, capped at BUCKET_SIZE.
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    const refill = Math.floor(elapsed / REFILL_INTERVAL_MS);
    if (refill > 0) {
      bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + refill);
      bucket.lastRefill += refill * REFILL_INTERVAL_MS;
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: bucket.tokens,
    };
  }

  // No tokens. Compute time-to-next-token for Retry-After.
  const msToNext = REFILL_INTERVAL_MS - (now - bucket.lastRefill);
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil(msToNext / 1000)),
    remaining: 0,
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
