// src/app/api/tvl/route.ts
//
// Public listing endpoint. Shape mirrors DeFiLlama's /protocols so existing
// analytics tools can swap us in by URL. All numeric fields are present
// even when null so consumers don't have to existence-check every field.
//
// Cache-Control: served via Vercel's CDN with s-maxage=60 → the function
// only runs for the first request in each minute under heavy traffic.
// The indexer writes every 5 min so 60s freshness is overkill — but it
// keeps lists feeling alive for analysts checking in often.

import { NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

function usdFromE6(raw: string | null | undefined): number | null {
  if (raw == null) return null
  try {
    const n = BigInt(raw)
    if (n === BigInt(0)) return 0
    return Number(n) / 1e6
  } catch { return null }
}

export async function GET() {
  try {
    const r = await pool.query(
      `SELECT id, slug, name, tagline, category, logo_url,
              website, twitter, contract,
              tvl_usd_e6::text          AS tvl_usd_e6,
              tvl_ath_usd_e6::text      AS tvl_ath_usd_e6,
              tvl_ath_block,
              tvl_ath_at,
              revenue_cum_usd_e6::text  AS revenue_cum_usd_e6,
              revenue_ath_day_usd_e6::text AS revenue_ath_day_usd_e6,
              revenue_ath_day,
              volume_cum_usd_e6::text   AS volume_cum_usd_e6,
              volume_ath_day_usd_e6::text AS volume_ath_day_usd_e6,
              volume_ath_day,
              tvl_last_indexed_at,
              tvl_tracking_enabled
       FROM projects
       WHERE approved = true AND live = true AND tvl_tracking_enabled = true
       ORDER BY tvl_usd_e6 DESC NULLS LAST, name ASC`,
    )

    // Shape every row so consumers can rely on the field set being stable.
    // We use null (not 0) when there's no data — analytics tools that mistake
    // those would surface the bug themselves rather than averaging in zeros.
    const protocols = r.rows.map(p => ({
      // Core identity (matches DeFiLlama shape where possible)
      id:          String(p.id),
      slug:        p.slug,
      name:        p.name,
      symbol:      null,
      description: p.tagline ?? null,
      url:         p.website ?? null,
      twitter:     p.twitter ?? null,
      logo:        p.logo_url ?? null,
      chain:       "Arc",
      chains:      ["Arc"],
      category:    p.category ?? null,
      address:     p.contract ?? null,

      // Metrics — all USD, no rolling windows (cumulative + ATH only)
      tvl:               usdFromE6(p.tvl_usd_e6),
      tvl_ath:           usdFromE6(p.tvl_ath_usd_e6),
      tvl_ath_block:     p.tvl_ath_block ?? null,
      tvl_ath_at:        p.tvl_ath_at ?? null,

      revenue_cum:       usdFromE6(p.revenue_cum_usd_e6),
      revenue_ath_day:   usdFromE6(p.revenue_ath_day_usd_e6),
      revenue_ath_day_at:p.revenue_ath_day ?? null,

      volume_cum:        usdFromE6(p.volume_cum_usd_e6),
      volume_ath_day:    usdFromE6(p.volume_ath_day_usd_e6),
      volume_ath_day_at: p.volume_ath_day ?? null,

      last_indexed_at:   p.tvl_last_indexed_at ?? null,

      // Honesty about scope. Anyone diffing us vs DeFiLlama wants to know.
      methodology: {
        verification: "deployer-signed",
        pricing:      "stablecoin-balance",
        denomination: "USD",
        chain_count:  1,
        notes:        "TVL via balanceOf() at latest-6 blocks. Revenue + Volume from on-chain events with exact ABI-decoded amounts. Numbers reproducible by anyone with an Arc RPC.",
      },
    }))

    return NextResponse.json(
      {
        chain: "Arc",
        generated_at: new Date().toISOString(),
        count: protocols.length,
        protocols,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  } catch (e: any) {
    console.error("[api/tvl GET]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
