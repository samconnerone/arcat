// src/app/api/track/route.ts
//
// First-party, cookieless page-visit tracking. One row per (anonymous device,
// path, day) — deduped on write, so it can't storm the DB. No cookies, no PII,
// no third-party: the device id is the same anonymous localStorage id the AI
// widget uses. Powers admin growth metrics + per-project founder analytics.

export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"
import { enforce, rateLimit } from "@/lib/ratelimit"

const pool = getPool()

const tableReady = pool.query(`
  CREATE TABLE IF NOT EXISTS page_visits (
    device_id  TEXT NOT NULL,
    path       TEXT NOT NULL,
    day        DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS page_visits_uniq ON page_visits (device_id, path, day)`
)).catch(e => console.error("[track] table init:", e?.message || e))

// Keep the raw table bounded — roll off visits older than 90 days. Opportunistic,
// guarded to run at most once/day (same pattern as the rate-limit cleanup).
async function pruneOld() {
  const gate = await rateLimit("page-visits-prune", 1, 24 * 60 * 60 * 1000)
  if (!gate.allowed) return
  await pool.query(`DELETE FROM page_visits WHERE day < CURRENT_DATE - 90`).catch(() => {})
}

export async function POST(req: NextRequest) {
  // Generous limit — this is one call per page view. Flood protection only.
  const blocked = await enforce(req, "track", { limit: 80, windowMs: 60_000 })
  if (blocked) return blocked

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: false }, { status: 400 }) }

  const device = (req.headers.get("x-arcat-device") || body?.device || "")
    .toString().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
  let path = (body?.path || "").toString().trim()
  // Only track internal app paths; ignore anything odd/absolute.
  if (!path.startsWith("/") || path.length > 200) return NextResponse.json({ ok: false }, { status: 400 })
  path = path.split(/[?#]/)[0]   // drop query/hash — the page is what matters
  if (!device) return NextResponse.json({ ok: true })   // no id yet — silently skip

  try {
    await tableReady
    await pool.query(
      `INSERT INTO page_visits (device_id, path) VALUES ($1, $2)
       ON CONFLICT (device_id, path, day) DO NOTHING`,
      [device, path],
    )
    void pruneOld()
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error("[track]", e?.message || e)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
