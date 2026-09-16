/**
 * Postgres-backed fixed-window rate limiter.
 *
 * One small table tracks per-key counters bucketed by epoch-second / windowSec.
 * Survives across Vercel function instances (in-memory wouldn't — each cold
 * function gets a fresh Map). Each call is one UPSERT round-trip.
 *
 * Fails open: if the limiter table is unreachable, requests are allowed
 * through. Better to let traffic flow than to take real users offline because
 * of a limiter outage.
 */
import { NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const tableReady = pool.query(`
  CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT PRIMARY KEY,
    count        INTEGER     NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(e => console.error("[ratelimit] init:", e))

export interface RateLimitResult {
  allowed:   boolean
  remaining: number
  resetIn:   number   // ms until the current window rolls over
}

/**
 * Check + record a single request against `key`.
 *
 * @param key      unique caller identifier, e.g. `"otp-send:1.2.3.4"`
 * @param limit    max requests allowed per window
 * @param windowMs window length in ms
 */
export async function rateLimit(
  key:      string,
  limit:    number,
  windowMs: number
): Promise<RateLimitResult> {
  try {
    await tableReady
    const windowSec = Math.max(1, Math.floor(windowMs / 1000))
    const bucket    = Math.floor(Date.now() / 1000 / windowSec)
    const bucketKey = `${key}:${bucket}`

    const res = await pool.query(
      `INSERT INTO rate_limits (key, count, window_start)
       VALUES ($1, 1, NOW())
       ON CONFLICT (key) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [bucketKey]
    )
    const count = res.rows[0].count as number

    const elapsedInWindowMs = (Math.floor(Date.now() / 1000) % windowSec) * 1000
    const resetIn = windowMs - elapsedInWindowMs

    // Opportunistic sweep: once per ~500 requests, drop stale buckets so the
    // table doesn't grow forever. ~24h kept is enough for analytics + retry.
    if (Math.random() < 0.002) {
      pool.query(`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '24 hours'`)
        .catch(() => {})
    }

    if (count > limit) return { allowed: false, remaining: 0, resetIn }
    return { allowed: true, remaining: Math.max(0, limit - count), resetIn }
  } catch (e) {
    console.error("[ratelimit] enforce:", e)
    return { allowed: true, remaining: limit, resetIn: windowMs }
  }
}

/** Extract the caller's IP from a Next.js Request. */
export function getIp(req: Request): string {
  const h = (req as any).headers
  const get = (k: string) =>
    typeof h.get === "function" ? h.get(k) : (h[k] ?? null)
  const raw =
    get("x-forwarded-for") ??
    get("x-real-ip") ??
    "unknown"
  return String(raw).split(",")[0].trim() || "unknown"
}

/**
 * Convenience wrapper: returns null on pass or a 429 response on block.
 * Adds standard RateLimit headers for client visibility.
 */
export async function enforce(
  req: Request,
  name: string,
  opts: { limit: number; windowMs: number; extra?: string }
): Promise<NextResponse | null> {
  const ip   = getIp(req)
  const key  = `${name}:${ip}${opts.extra ? `:${opts.extra}` : ""}`
  const res  = await rateLimit(key, opts.limit, opts.windowMs)
  if (res.allowed) return null
  const retryAfter = Math.ceil(res.resetIn / 1000)
  return NextResponse.json(
    { error: `Too many requests. Try again in ${retryAfter}s.` },
    {
      status: 429,
      headers: {
        "Retry-After":          String(retryAfter),
        "X-RateLimit-Limit":    String(opts.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset":    String(Math.floor(Date.now() / 1000) + retryAfter),
      },
    }
  )
}
