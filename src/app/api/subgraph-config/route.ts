// src/app/api/subgraph-config/route.ts
//
// Founder self-serve config for PROTOCOL-REPORTED (subgraph) metrics. A project
// that runs its own subgraph can point Arcat at it here; the subgraph-metrics
// cron then polls it and displays the numbers with a clear "self-reported"
// label (never the green verified badge — that path is on-chain contract
// tracking in /api/project-contracts).
//
// Security:
//   • Owner-gated: the signed-in wallet must own the project (or a claim
//     token), reusing the resolveProject pattern from /api/project-contracts.
//   • SSRF-guarded: we POST to a founder-supplied URL, so https-only and
//     private/internal hosts are refused (a founder could otherwise probe
//     internal services).
//
// Actions (POST body.action):
//   "test" → run the query live, return the extracted values. Never persists.
//   "save" → validate + store the config. Clearing the url disables the feed.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"
import { getSession } from "@/lib/session"
import { enforce } from "@/lib/ratelimit"

const pool = getPool()

// ── helpers mirrored from the subgraph-metrics cron ──────────────────────────
const dig = (obj: any, path: string) =>
  path.split(".").reduce((o: any, k: string) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), obj)
const usdNum = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null }

// ── SSRF guard: https only, no private/internal hosts ────────────────────────
function isSafeSubgraphUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return { ok: false, error: "Enter a valid URL" } }
  if (u.protocol !== "https:") return { ok: false, error: "Subgraph URL must be https" }
  const host = u.hostname.toLowerCase()
  if (
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||          // link-local / cloud metadata
    /^\[?::1\]?$/.test(host)             // ipv6 loopback
  ) {
    return { ok: false, error: "That host isn't allowed" }
  }
  return { ok: true, url: u.toString() }
}

async function gql(url: string, query: string): Promise<{ data: any | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { data: null, error: `Subgraph returned HTTP ${res.status}` }
    const j = await res.json().catch(() => null)
    if (j?.errors?.length) return { data: null, error: j.errors[0]?.message || "GraphQL error" }
    return { data: j?.data ?? null, error: j?.data ? null : "Subgraph returned no data" }
  } catch (e) {
    return { data: null, error: (e as Error)?.name === "TimeoutError" ? "Subgraph timed out" : "Couldn't reach the subgraph" }
  }
}

async function resolveProject(slug: string, addr: string | null, token: string | null) {
  if (token) {
    const r = await pool.query(
      `SELECT id, slug FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2 AND claim_token_expires >= NOW()`,
      [slug, token],
    )
    if (r.rows[0]) return r.rows[0]
  }
  if (addr) {
    const r = await pool.query(
      `SELECT id, slug FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2`,
      [slug, addr],
    )
    if (r.rows[0]) return r.rows[0]
  }
  return null
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")
  const token = req.nextUrl.searchParams.get("token")
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })
  const sess = getSession(req)
  const project = await resolveProject(slug, sess?.addr ?? null, token)
  if (!project) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  const r = await pool.query(
    `SELECT subgraph_url, subgraph_query, subgraph_tvl_path, subgraph_volume_path,
            subgraph_source_ts_path, subgraph_series_query, subgraph_series_path,
            subgraph_series_x, subgraph_series_y,
            subgraph_tvl_usd_e6::text AS tvl_e6, subgraph_volume_usd_e6::text AS vol_e6,
            subgraph_updated_at
       FROM projects WHERE id = $1`,
    [project.id],
  )
  return NextResponse.json({ config: r.rows[0] || {} }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "subgraph-config", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }) }

  const sess = getSession(req)
  const project = await resolveProject(String(body?.slug || ""), sess?.addr ?? null, body?.token || null)
  if (!project) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  const action = String(body?.action || "test")
  const url          = String(body?.subgraph_url || "").trim()
  const query        = String(body?.subgraph_query || "").trim()
  const tvlPath      = String(body?.subgraph_tvl_path || "").trim()
  const volPath      = String(body?.subgraph_volume_path || "").trim()
  const tsPath       = String(body?.subgraph_source_ts_path || "").trim()
  const seriesQuery  = String(body?.subgraph_series_query || "").trim()
  const seriesPath   = String(body?.subgraph_series_path || "").trim()
  const seriesX      = String(body?.subgraph_series_x || "").trim()
  const seriesY      = String(body?.subgraph_series_y || "").trim()

  // "save" with an empty URL clears the feed entirely.
  if (action === "save" && !url) {
    await pool.query(
      `UPDATE projects SET subgraph_url = NULL, subgraph_query = NULL,
         subgraph_tvl_path = NULL, subgraph_volume_path = NULL, subgraph_source_ts_path = NULL,
         subgraph_series_query = NULL, subgraph_series_path = NULL, subgraph_series_x = NULL, subgraph_series_y = NULL
       WHERE id = $1`,
      [project.id],
    )
    return NextResponse.json({ success: true, cleared: true })
  }

  const safe = isSafeSubgraphUrl(url)
  if (safe.ok === false) return NextResponse.json({ error: safe.error }, { status: 400 })
  if (!query) return NextResponse.json({ error: "A GraphQL query is required" }, { status: 400 })
  if (!tvlPath && !volPath) return NextResponse.json({ error: "Set at least a TVL or a Volume path" }, { status: 400 })

  // Run the query live — used by BOTH test and save (save won't persist a config
  // that doesn't actually return a number).
  const { data, error } = await gql(safe.url, query)
  if (error) return NextResponse.json({ error }, { status: 400 })

  const tvl = tvlPath ? usdNum(dig(data, tvlPath)) : null
  const vol = volPath ? usdNum(dig(data, volPath)) : null
  const ts  = tsPath ? usdNum(dig(data, tsPath)) : null

  if (tvl == null && vol == null) {
    return NextResponse.json({
      error: "The query ran, but neither path pointed at a number. Check the paths against the response.",
      sample: JSON.stringify(data).slice(0, 400),
    }, { status: 400 })
  }

  // Optional history series — validated only when all four fields are present.
  let seriesCount: number | null = null
  if (seriesQuery && seriesPath && seriesX && seriesY) {
    const sd = await gql(safe.url, seriesQuery)
    const arr = sd.data ? dig(sd.data, seriesPath) : null
    seriesCount = Array.isArray(arr) ? arr.length : 0
  }

  const extracted = { tvl_usd: tvl, volume_usd: vol, source_ts: ts, series_points: seriesCount }

  if (action === "test") {
    return NextResponse.json({ success: true, extracted })
  }

  // action === "save"
  await pool.query(
    `UPDATE projects SET
       subgraph_url = $2, subgraph_query = $3,
       subgraph_tvl_path = $4, subgraph_volume_path = $5, subgraph_source_ts_path = $6,
       subgraph_series_query = $7, subgraph_series_path = $8, subgraph_series_x = $9, subgraph_series_y = $10,
       subgraph_tvl_usd_e6 = COALESCE($11, subgraph_tvl_usd_e6),
       subgraph_volume_usd_e6 = COALESCE($12, subgraph_volume_usd_e6),
       subgraph_updated_at = NOW()
     WHERE id = $1`,
    [
      project.id, safe.url, query,
      tvlPath || null, volPath || null, tsPath || null,
      seriesQuery || null, seriesPath || null, seriesX || null, seriesY || null,
      tvl != null ? BigInt(Math.round(tvl * 1e6)).toString() : null,
      vol != null ? BigInt(Math.round(vol * 1e6)).toString() : null,
    ],
  )
  return NextResponse.json({ success: true, extracted })
}
