import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// Self-heal: the view-record INSERT below uses ON CONFLICT (project_id, device_id,
// week_num), which REQUIRES this unique index. If the index is ever missing the
// insert throws and view recording silently dies (it did, for ~5 weeks). Ensure
// it exists once at startup so recording can't break that way again.
void pool
  .query(`CREATE UNIQUE INDEX IF NOT EXISTS project_views_uniq ON project_views (project_id, device_id, week_num)`)
  .catch(e => console.error("[ecosystem/[id]] project_views index init:", e?.message || e))

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    // Find by slug first, then by numeric id
    const result = await pool.query(
      `SELECT id, name, slug, tagline, description, category, logo_url,
              website, twitter, github, discord, contract,
              founder_social, owner_wallet,
              recognition, trust_level, trust_profile, established,
              auditor, audit_url,
              featured, badge, color, created_at,
              COALESCE(view_count, 0) as view_count,
              city, country, lat, lng,
              tvl_tracking_enabled,
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
              subgraph_tvl_usd_e6::text    AS subgraph_tvl_usd_e6,
              subgraph_volume_usd_e6::text AS subgraph_volume_usd_e6,
              subgraph_updated_at,
              subgraph_source_ts::text     AS subgraph_source_ts,
              subgraph_series
       FROM projects
       WHERE approved = true AND live = true
         AND (slug = $1 OR id::text = $1)
       LIMIT 1`,
      [id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const project = result.rows[0]

    // Founder linkage: a claimed project's owner_wallet IS a builder profile.
    // Prefer pointing "Founder" at that wallet-proven profile (rich + verified)
    // over the self-disclosed social link. If the wallet hasn't filled a profile
    // yet, the builder page still shows their on-chain track record, so we link
    // it anyway. Falls back to the typed founder_social on the page when there's
    // no owner wallet at all.
    let founderProfile: any = null
    if (project.owner_wallet) {
      const owner = String(project.owner_wallet).toLowerCase()
      try {
        const bp = await pool.query(
          `SELECT address, display_name, avatar_url, verified, claimed_at FROM builder_profiles WHERE address = $1`,
          [owner]
        )
        const row = bp.rows[0]
        founderProfile = {
          address:      owner,
          display_name: row?.display_name || null,
          avatar_url:   row?.avatar_url   || null,
          verified:     !!row?.verified,
          claimed:      !!row?.claimed_at,
        }
      } catch {
        founderProfile = { address: owner, display_name: null, avatar_url: null, verified: false, claimed: false }
      }
    }

    // Fetch tx count for contract if available
    let txCount: string | null = null
    if (project.contract) {
      try {
        const res = await fetch(
          `https://testnet.arcscan.app/api/v2/addresses/${project.contract}/counters`,
          { next: { revalidate: 60 } }
        )
        const data = await res.json()
        if (data?.transactions_count) txCount = data.transactions_count
      } catch { }
    }

    // Related projects — same category, excluding this one
    const related = await pool.query(
      `SELECT id, name, slug, tagline, category, logo_url, badge, color
       FROM projects
       WHERE approved = true AND live = true
         AND category = $1 AND id != $2
       ORDER BY featured DESC, COALESCE(view_count, 0) DESC
       LIMIT 4`,
      [project.category, project.id]
    )

    // All-time leaderboard for this project. Aggregates across every campaign.
    // Builder-rated reviewed entries only (no unrated spam).
    //
    // XP-aware ranking: if any of this project's campaigns has max_xp set,
    // the board sorts by SUM(xp_earned). Otherwise we fall back to the legacy
    // quality_score sum so projects that opted out keep their existing behavior.
    let leaderboard: any[] = []
    let campaignsRun  = 0
    let usingXp       = false
    try {
      const xpFlag = await pool.query(
        `SELECT 1 FROM campaigns WHERE project_id = $1 AND max_xp_per_completion IS NOT NULL LIMIT 1`,
        [project.id]
      )
      usingXp = xpFlag.rowCount > 0

      const lbRes = await pool.query(
        `SELECT
           cc.tester_wallet,
           COUNT(*)::int                                AS campaigns_completed,
           AVG(cc.quality_score)::numeric(6,2)          AS avg_quality,
           AVG(cc.builder_rating)::numeric(4,2)         AS avg_rating,
           SUM(cc.quality_score)::int                   AS total_score,
           SUM(cc.xp_earned)::int                       AS total_xp,
           MAX(cc.created_at)                           AS last_active,
           -- Join the tester's platform-wide reputation so the project
           -- leaderboard can show Arcat rank + avg_score next to their
           -- project XP. Same star rating powers both, so a tester high
           -- on Tower XP is naturally already climbing the Arcat ladder.
           COALESCE(tr.rank, 0)::int                    AS platform_rank,
           COALESCE(tr.avg_score, 0)::numeric(4,2)      AS platform_avg
         FROM campaign_completions cc
         JOIN campaigns c ON c.id = cc.campaign_id
         LEFT JOIN tester_reputation tr ON tr.wallet = cc.tester_wallet
         WHERE c.project_id = $1
           AND cc.status = 'reviewed'
           AND cc.builder_rating IS NOT NULL
         GROUP BY cc.tester_wallet, tr.rank, tr.avg_score
         ORDER BY ${usingXp ? "total_xp DESC, " : ""}total_score DESC, avg_quality DESC
         LIMIT 20`,
        [project.id]
      )
      leaderboard = lbRes.rows
      const campCount = await pool.query(
        `SELECT COUNT(*)::int AS n FROM campaigns WHERE project_id = $1 AND status IN ('active','ended')`,
        [project.id]
      )
      campaignsRun = campCount.rows[0]?.n || 0
    } catch (e) {
      // Don't fail the page if the leaderboard query has a hiccup
      console.error("[Ecosystem GET id] leaderboard query failed", e)
    }

    // ─── TVL detail (only when the founder has opted in) ─────────────────────
    // Three pieces:
    //   (a) per-contract breakdown at the latest snapshot → audit table
    //   (b) a downsampled time series for the sparkline / chart
    //   (c) the live list of registered tracked contracts (with verification)
    let tvl: any = null
    if (project.tvl_tracking_enabled) {
      try {
        const latest = await pool.query(
          `SELECT id, block_number, block_time,
                  total_usd_e6::text AS total_usd_e6,
                  breakdown
           FROM tvl_snapshots
           WHERE project_id = $1
           ORDER BY block_number DESC LIMIT 1`,
          [project.id]
        )

        // Sparkline series: ≤90 evenly distributed snapshots since first
        // recorded TVL. Using a window function keeps Postgres doing the work
        // and bounds the JSON payload no matter how many snapshots exist.
        const series = await pool.query(
          `WITH s AS (
             SELECT block_number, block_time, total_usd_e6,
                    ROW_NUMBER() OVER (ORDER BY block_number ASC) AS rn,
                    COUNT(*)     OVER ()                          AS n
             FROM tvl_snapshots WHERE project_id = $1
           )
           SELECT block_number, block_time, total_usd_e6::text AS total_usd_e6
           FROM s
           WHERE rn % GREATEST(1, n / 90) = 0 OR rn = 1 OR rn = n
           ORDER BY block_number ASC`,
          [project.id]
        )

        const contracts = await pool.query(
          `SELECT id, address, role, label, start_block,
                  deployer_address, verified_at, revoked_at,
                  volume_method
           FROM project_contracts
           WHERE project_id = $1 AND verified_at IS NOT NULL AND revoked_at IS NULL
           ORDER BY role, id`,
          [project.id]
        )

        // Revenue daily series (last ~90 days) for the revenue sparkline.
        const revSeries = await pool.query(
          `SELECT day, total_usd_e6::text AS total_usd_e6, event_count
           FROM revenue_daily WHERE project_id = $1
           ORDER BY day DESC LIMIT 90`,
          [project.id]
        )
        const volSeries = await pool.query(
          `SELECT day, total_usd_e6::text AS total_usd_e6, event_count
           FROM volume_daily WHERE project_id = $1
           ORDER BY day DESC LIMIT 90`,
          [project.id]
        )

        tvl = {
          latest: latest.rows[0] ?? null,
          series: series.rows,
          revenue_series: revSeries.rows.reverse(),
          volume_series: volSeries.rows.reverse(),
          contracts: contracts.rows,
        }
      } catch (e) {
        console.error("[Ecosystem GET id] tvl detail failed", e)
      }
    }

    return NextResponse.json(
      { project: { ...project, txCount, owner_wallet: undefined, founder_profile: founderProfile }, related: related.rows, leaderboard, campaignsRun, usingXp, tvl },
      // Each detail page costs ~a dozen queries, and search crawlers now reach
      // all ~310 of them. Five minutes was short enough that repeat visitors and
      // re-crawls paid the full cost again; an hour (serving stale for a day
      // while it refreshes) cuts that without anyone noticing — this data moves
      // on the order of days, not minutes.
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
    )
  } catch (err) {
    console.error("[Ecosystem GET id]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await req.json()
    const { deviceId } = body
    if (!deviceId) return NextResponse.json({ ok: true })

    const proj = await pool.query(
      `SELECT id FROM projects WHERE (slug = $1 OR id::text = $1) AND approved = true AND live = true LIMIT 1`,
      [id]
    )
    if (proj.rows.length === 0) return NextResponse.json({ ok: true })

    const projectId = proj.rows[0].id
    const weekNum   = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))

    await pool.query(
      `INSERT INTO project_views (project_id, device_id, week_num)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, device_id, week_num) DO NOTHING`,
      [projectId, deviceId, weekNum]
    )
    await pool.query(
      `UPDATE projects SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1`,
      [projectId]
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[Ecosystem POST id]", err)
    return NextResponse.json({ ok: true })
  }
}
