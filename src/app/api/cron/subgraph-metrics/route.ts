// src/app/api/cron/subgraph-metrics/route.ts
//
// Polls each project's configured subgraph for TVL/volume and stores it in the
// subgraph_*_usd_e6 columns. These numbers are PROTOCOL-REPORTED (the project
// runs its own subgraph) and are surfaced with a clear label — they are NOT
// independently on-chain-verified by Arcat, unlike tvl_usd_e6.
//
// Why: big multi-pool DEXes (Achswap = 833 V2+V3 pools, ~$2.3M TVL) can't be
// represented by our per-registered-contract on-chain indexer. Their own
// subgraph already aggregates the full picture; we consume it, labelled.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

export const runtime = "nodejs"
export const maxDuration = 60

const pool = getPool()

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  return !!expected && req.headers.get("authorization") === `Bearer ${expected}`
}

// Extract a value by dot-path, supporting numeric array indices.
//   dig({ protocols: [{ totalTvlUsd: "1" }] }, "protocols.0.totalTvlUsd") -> "1"
function dig(obj: any, path: string): any {
  if (!path) return undefined
  return path.split(".").reduce(
    (o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]),
    obj,
  )
}

// A decimal-USD string/number -> USD micro-units (e6) bigint. Rejects garbage.
function usdToE6(v: any): bigint | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return BigInt(Math.round(n * 1e6))
}

// A finite non-negative number, or null. For the freshness timestamp.
function num(v: any): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// POST a GraphQL query to a subgraph; returns parsed `data` or null on any error.
async function gql(url: string, query: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const j = await res.json()
    if (j?.errors) return null
    return j?.data ?? null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const stats = { configured: 0, updated: 0, errors: 0 }
  const client = await pool.connect()
  try {
    const rows = (await client.query(
      `SELECT id, slug, subgraph_url, subgraph_query, subgraph_tvl_path, subgraph_volume_path,
              subgraph_source_ts_path, subgraph_series_query, subgraph_series_path,
              subgraph_series_x, subgraph_series_y
       FROM projects
       WHERE subgraph_url IS NOT NULL AND subgraph_url <> '' AND approved AND live`,
    )).rows
    stats.configured = rows.length

    for (const p of rows) {
      try {
        const data = await gql(p.subgraph_url, p.subgraph_query)
        if (data == null) { stats.errors++; continue }

        const tvlE6    = p.subgraph_tvl_path ? usdToE6(dig(data, p.subgraph_tvl_path)) : null
        const volE6    = p.subgraph_volume_path ? usdToE6(dig(data, p.subgraph_volume_path)) : null
        const sourceTs = p.subgraph_source_ts_path ? num(dig(data, p.subgraph_source_ts_path)) : null
        if (tvlE6 == null && volE6 == null) { stats.errors++; continue }

        // Daily TVL history — a second query, if configured. Yields an ascending
        // [{ t: unixSeconds, usd }] series we can chart. Best-effort: a failure
        // here never blocks the headline number.
        let series: Array<{ t: number; usd: number }> | null = null
        if (p.subgraph_series_query && p.subgraph_series_path && p.subgraph_series_x && p.subgraph_series_y) {
          const sd = await gql(p.subgraph_url, p.subgraph_series_query)
          const arr = sd ? dig(sd, p.subgraph_series_path) : null
          if (Array.isArray(arr)) {
            series = arr
              .map((row: any) => ({ t: num(row?.[p.subgraph_series_x]), usd: num(row?.[p.subgraph_series_y]) }))
              .filter((pt): pt is { t: number; usd: number } => pt.t != null && pt.usd != null)
              .sort((a, b) => a.t - b.t)
              .slice(-60)
          }
        }

        // COALESCE so a partial response never wipes an existing value.
        await client.query(
          `UPDATE projects SET
             subgraph_tvl_usd_e6    = COALESCE($2, subgraph_tvl_usd_e6),
             subgraph_volume_usd_e6 = COALESCE($3, subgraph_volume_usd_e6),
             subgraph_source_ts     = COALESCE($4, subgraph_source_ts),
             subgraph_series        = COALESCE($5::jsonb, subgraph_series),
             subgraph_updated_at    = NOW()
           WHERE id = $1`,
          [
            p.id,
            tvlE6?.toString() ?? null,
            volE6?.toString() ?? null,
            sourceTs ?? null,
            series ? JSON.stringify(series) : null,
          ],
        )
        stats.updated++
      } catch {
        stats.errors++
      }
    }
    return NextResponse.json({ ok: true, ...stats })
  } catch (e: any) {
    console.error("[subgraph-metrics cron]", e?.message || e)
    return NextResponse.json({ ok: false, error: e?.message || String(e), ...stats }, { status: 500 })
  } finally {
    client.release()
  }
}
