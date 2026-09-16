// src/app/api/tvl/[slug]/route.ts
//
// Single-project detail endpoint. Returns:
//   • Identity + current metrics (same as the list endpoint)
//   • TVL snapshot series (downsampled to ≤ 200 points)
//   • Revenue daily series
//   • Volume daily series
//   • The list of verified tracked contracts (per-contract audit)
//
// Used by external dashboards that want to chart a single protocol; the
// shape is friendlier for plotting than the list endpoint.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

function usdFromE6(raw: string | null | undefined): number | null {
  if (raw == null) return null
  try {
    const n = BigInt(raw)
    return Number(n) / 1e6
  } catch { return null }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  try {
    const r = await pool.query(
      `SELECT id, slug, name, tagline, description, category, logo_url,
              website, twitter, contract,
              tvl_usd_e6::text          AS tvl_usd_e6,
              tvl_ath_usd_e6::text      AS tvl_ath_usd_e6,
              tvl_ath_block, tvl_ath_at,
              revenue_cum_usd_e6::text  AS revenue_cum_usd_e6,
              revenue_ath_day_usd_e6::text AS revenue_ath_day_usd_e6,
              revenue_ath_day,
              volume_cum_usd_e6::text   AS volume_cum_usd_e6,
              volume_ath_day_usd_e6::text AS volume_ath_day_usd_e6,
              volume_ath_day,
              tvl_last_indexed_at, tvl_tracking_enabled
       FROM projects
       WHERE (slug = $1 OR id::text = $1)
         AND approved = true AND live = true
       LIMIT 1`,
      [slug],
    )
    if (r.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const p = r.rows[0]
    if (!p.tvl_tracking_enabled) {
      return NextResponse.json(
        { error: "This project has not enabled TVL tracking." },
        { status: 404 },
      )
    }

    // Downsampled TVL series — every Nth snapshot so the payload stays small
    // even for projects with months of data.
    const tvlSeries = await pool.query(
      `WITH s AS (
         SELECT block_number, block_time, total_usd_e6::text AS total_usd_e6,
                ROW_NUMBER() OVER (ORDER BY block_number ASC) AS rn,
                COUNT(*)     OVER ()                          AS n
         FROM tvl_snapshots WHERE project_id = $1
       )
       SELECT block_number, block_time, total_usd_e6
       FROM s
       WHERE rn % GREATEST(1, n / 200) = 0 OR rn = 1 OR rn = n
       ORDER BY block_number ASC`,
      [p.id],
    )

    const revenueSeries = await pool.query(
      `SELECT day::text, total_usd_e6::text, event_count
       FROM revenue_daily WHERE project_id = $1 ORDER BY day ASC`,
      [p.id],
    )
    const volumeSeries = await pool.query(
      `SELECT day::text, total_usd_e6::text, event_count
       FROM volume_daily WHERE project_id = $1 ORDER BY day ASC`,
      [p.id],
    )

    const contracts = await pool.query(
      `SELECT pc.id, pc.address, pc.role, pc.label, pc.start_block,
              pc.deployer_address, pc.verified_at,
              pc.volume_event_signature, pc.volume_amount_arg,
              s.symbol AS volume_stablecoin
       FROM project_contracts pc
       LEFT JOIN stablecoins s ON s.id = pc.volume_stablecoin_id
       WHERE pc.project_id = $1
         AND pc.verified_at IS NOT NULL
         AND pc.revoked_at IS NULL
       ORDER BY pc.role, pc.id`,
      [p.id],
    )

    return NextResponse.json(
      {
        generated_at: new Date().toISOString(),
        project: {
          id:           String(p.id),
          slug:         p.slug,
          name:         p.name,
          symbol:       null,
          description:  p.tagline ?? null,
          long_description: p.description ?? null,
          url:          p.website ?? null,
          twitter:      p.twitter ?? null,
          logo:         p.logo_url ?? null,
          chain:        "Arc",
          category:     p.category ?? null,
          address:      p.contract ?? null,

          tvl:                usdFromE6(p.tvl_usd_e6),
          tvl_ath:            usdFromE6(p.tvl_ath_usd_e6),
          tvl_ath_block:      p.tvl_ath_block ?? null,
          tvl_ath_at:         p.tvl_ath_at ?? null,
          revenue_cum:        usdFromE6(p.revenue_cum_usd_e6),
          revenue_ath_day:    usdFromE6(p.revenue_ath_day_usd_e6),
          revenue_ath_day_at: p.revenue_ath_day ?? null,
          volume_cum:         usdFromE6(p.volume_cum_usd_e6),
          volume_ath_day:     usdFromE6(p.volume_ath_day_usd_e6),
          volume_ath_day_at:  p.volume_ath_day ?? null,
          last_indexed_at:    p.tvl_last_indexed_at ?? null,
        },
        tvl_history: tvlSeries.rows.map(s => ({
          block: Number(s.block_number),
          at:    s.block_time,
          tvl:   usdFromE6(s.total_usd_e6),
        })),
        revenue_daily: revenueSeries.rows.map(d => ({
          day:         d.day,
          revenue:     usdFromE6(d.total_usd_e6),
          event_count: d.event_count,
        })),
        volume_daily: volumeSeries.rows.map(d => ({
          day:         d.day,
          volume:      usdFromE6(d.total_usd_e6),
          event_count: d.event_count,
        })),
        tracked_contracts: contracts.rows.map(c => ({
          id:            c.id,
          address:       c.address,
          role:          c.role,
          label:         c.label,
          start_block:   Number(c.start_block),
          deployer:      c.deployer_address,
          verified_at:   c.verified_at,
          // Volume-only metadata so analysts can reproduce the math
          ...(c.role === "volume" ? {
            event_signature: c.volume_event_signature,
            amount_arg:      c.volume_amount_arg,
            stablecoin:      c.volume_stablecoin,
          } : {}),
        })),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
          "Access-Control-Allow-Origin": "*",
        },
      },
    )
  } catch (e: any) {
    console.error("[api/tvl/[slug] GET]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
