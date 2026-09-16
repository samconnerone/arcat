// src/app/api/cron/tvl-drift/route.ts
//
// Hourly self-audit. This is the trust feature: we don't just compute
// numbers — we re-check them against the chain and against the raw events
// table on a schedule, and publish any inconsistency to `indexer_alerts`
// for the admin panel + the per-project page to surface.
//
// The TVL pipeline already polls `balanceOf()` every 5 min so balance "drift"
// in the classical event-derived sense can't happen. What CAN go wrong:
//
//   1. A partial cron tick leaves `projects.tvl_usd_e6` out of sync with the
//      latest snapshot or the on-chain truth.
//   2. A cursor advances but a downstream rollup fails → cached cum/ATH disagrees
//      with the authoritative events table.
//   3. The indexer cron gets stuck (Arc RPC outage etc.) and cursors fall behind.
//   4. The forex_rates table goes stale and non-USD pegs use yesterday's rate.
//
// All four surface here. No silent miscounts.

import { NextRequest, NextResponse } from "next/server"
import { PoolClient } from "pg"
import { ethers } from "ethers"
import { ARC_RPC_HTTP } from "@/lib/constants"
import {
  ERC20_BALANCE_ABI,
  REORG_BUFFER,
  toUsdE6,
  type StablecoinRow,
  type ForexMap,
} from "@/lib/tvl"
import { getPool } from "@/lib/dbPool"

export const runtime = "nodejs"
export const maxDuration = 300

const pool = getPool()

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return req.headers.get("authorization") === `Bearer ${expected}`
}

// Tolerance for balance drift: 0.2% of the larger side, or $25 absolute
// (whichever is greater). A live-updating TVL drifts a little just from snapshot
// vs head timing — below this it's noise, not a real discrepancy.
function exceedsDriftTolerance(cached: bigint, actual: bigint): boolean {
  const diff = cached > actual ? cached - actual : actual - cached
  if (diff === BigInt(0)) return false
  const bigger = cached > actual ? cached : actual
  const pct = bigger / BigInt(500)        // 0.2%
  const floor = BigInt(25_000_000)        // $25 in usd_e6
  const tolerance = pct > floor ? pct : floor
  return diff > tolerance
}

async function loadActiveStablecoins(c: PoolClient): Promise<StablecoinRow[]> {
  const r = await c.query<StablecoinRow>(
    `SELECT id, LOWER(address) AS address, symbol, decimals, peg_currency
     FROM stablecoins WHERE active = true ORDER BY id`,
  )
  return r.rows
}

async function loadTodaysForex(c: PoolClient): Promise<ForexMap> {
  const r = await c.query<{ currency: string; rate_to_usd: string }>(
    `SELECT DISTINCT ON (currency) currency, rate_to_usd::text
     FROM forex_rates WHERE effective_date <= CURRENT_DATE
     ORDER BY currency, effective_date DESC`,
  )
  const out: ForexMap = {}
  for (const row of r.rows) {
    out[row.currency] = { rate: Number(row.rate_to_usd), effective_date: "", source: "" }
  }
  if (!out.USD) out.USD = { rate: 1, effective_date: "synthetic", source: "hardcoded" }
  return out
}

async function recordAlert(
  c: PoolClient,
  projectId: number | null,
  kind: string,
  severity: "info" | "warning" | "critical",
  message: string,
  details?: Record<string, unknown>,
  dedupeKey?: string,
) {
  // With a dedupeKey, keep ONE open alert per recurring condition and refresh it
  // each run instead of inserting a new row every tick (the hourly cursor/forex
  // checks would otherwise flood the admin with identical duplicates).
  if (dedupeKey) {
    const merged = { ...(details || {}), dedupeKey }
    const existing = await c.query(
      `SELECT id FROM indexer_alerts WHERE resolved_at IS NULL AND kind = $1 AND details->>'dedupeKey' = $2 LIMIT 1`,
      [kind, dedupeKey],
    )
    if (existing.rows.length) {
      await c.query(
        `UPDATE indexer_alerts SET severity = $1, message = $2, details = $3::jsonb, created_at = NOW() WHERE id = $4`,
        [severity, message, JSON.stringify(merged), existing.rows[0].id],
      )
      return
    }
    await c.query(
      `INSERT INTO indexer_alerts (project_id, kind, severity, message, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [projectId, kind, severity, message, JSON.stringify(merged)],
    )
    return
  }
  await c.query(
    `INSERT INTO indexer_alerts (project_id, kind, severity, message, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [projectId, kind, severity, message, details ? JSON.stringify(details) : null],
  )
}

// ─── ENTRYPOINT ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const stats = {
    head: 0,
    tvlContractsChecked: 0,
    tvlDriftAlerts: 0,
    rollupAlerts: 0,
    cursorAlerts: 0,
    forexAlerts: 0,
    totalAlerts: 0,
    elapsedMs: 0,
  }
  const startedAt = Date.now()
  const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
  const client = await pool.connect()

  try {
    // Resilient head-block fetch — Arc's public RPC occasionally blinks.
    // One retry with a short delay before recording an rpc_error alert.
    async function getHeadWithRetry(): Promise<number> {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { return await provider.getBlockNumber() }
        catch (e: any) {
          if (attempt === 2) throw e
          await new Promise(r => setTimeout(r, 1500))
        }
      }
      return 0
    }

    try {
      stats.head = await getHeadWithRetry()
    } catch (e: any) {
      // Don't fail the whole cron on a flaky RPC — record an alert and exit cleanly.
      // The next hourly tick will retry; if Arc RPC is durably down, alerts pile up.
      await recordAlert(client, null, "rpc_error", "warning",
        `Drift cron: getBlockNumber failed after 2 attempts: ${e?.message || e}`)
      stats.totalAlerts++
      stats.elapsedMs = Date.now() - startedAt
      return NextResponse.json({ ok: true, reason: "rpc_unavailable", ...stats })
    }

    // ─── CHECK 1: TVL balance drift ─────────────────────────────────────────
    // Sum balanceOf() at head per project, compare to the materialized
    // tvl_usd_e6. Anything exceeding our tolerance is recorded as a
    // 'tvl_drift' alert with the gap in basis points.
    const stables = await loadActiveStablecoins(client)
    const forex = await loadTodaysForex(client)
    const tvlContracts = await client.query<{
      contract_id: number
      project_id: number
      address: string
      start_block: number
      slug: string
      cached_tvl_usd_e6: string | null
    }>(
      `SELECT pc.id AS contract_id, pc.project_id, LOWER(pc.address) AS address,
              pc.start_block, p.slug, p.tvl_usd_e6::text AS cached_tvl_usd_e6
       FROM project_contracts pc
       JOIN projects p ON p.id = pc.project_id
       WHERE pc.role = 'tvl'
         AND pc.verified_at IS NOT NULL
         AND pc.revoked_at IS NULL
         AND p.tvl_tracking_enabled = true`,
    )

    const projectTotals = new Map<number, { usdE6: bigint; slug: string; cached: bigint }>()
    for (const row of tvlContracts.rows) {
      const cached = row.cached_tvl_usd_e6 ? BigInt(row.cached_tvl_usd_e6) : BigInt(0)
      if (!projectTotals.has(row.project_id)) {
        projectTotals.set(row.project_id, { usdE6: BigInt(0), slug: row.slug, cached })
      }
    }

    // Read balances at the SAME safe block the indexer writes from (head minus
    // the reorg buffer) so we compare like-for-like. Reading at bare head while
    // the cached value was computed at head-6 produced spurious drift alerts on
    // fast-moving pools (Arc blocks are ~0.5s, so 6 blocks of activity is real).
    const checkBlock = Math.max(0, stats.head - REORG_BUFFER)
    for (const row of tvlContracts.rows) {
      if (checkBlock < row.start_block) continue
      for (const s of stables) {
        try {
          const c20 = new ethers.Contract(s.address, ERC20_BALANCE_ABI, provider)
          const bal: bigint = await c20.balanceOf(row.address, { blockTag: checkBlock })
          if (bal === BigInt(0)) continue
          const fx = forex[s.peg_currency] ?? forex.USD
          const usdE6 = toUsdE6(bal, s.decimals, fx.rate)
          const tot = projectTotals.get(row.project_id)!
          tot.usdE6 += usdE6
        } catch (e: any) {
          await recordAlert(client, row.project_id, "rpc_error", "warning",
            `Drift check: balanceOf failed for ${row.address}/${s.symbol}: ${e?.message || e}`)
          stats.totalAlerts++
        }
      }
      stats.tvlContractsChecked++
    }

    for (const [projectId, { usdE6: actual, slug, cached }] of projectTotals) {
      if (exceedsDriftTolerance(cached, actual)) {
        const diff = cached > actual ? cached - actual : actual - cached
        await recordAlert(client, projectId, "tvl_drift", "warning",
          `${slug}: cached TVL $${(Number(cached) / 1e6).toFixed(2)} differs from on-chain $${(Number(actual) / 1e6).toFixed(2)} by $${(Number(diff) / 1e6).toFixed(2)}`,
          { cached_usd_e6: cached.toString(), actual_usd_e6: actual.toString(), check_block: checkBlock, head_block: stats.head },
          `tvl_drift:${projectId}`,
        )
        stats.tvlDriftAlerts++
        stats.totalAlerts++
      }
    }

    // ─── CHECK 2 & 3: revenue + volume rollup sanity ────────────────────────
    // Re-sum from the authoritative events tables and compare to the cached
    // cumulative columns. A mismatch means a rollup pass got interrupted
    // OR the materialization SQL has a bug.
    const rollupChecks = [
      { kind: "revenue", table: "revenue_events", cached_col: "revenue_cum_usd_e6" },
      { kind: "volume",  table: "volume_events",  cached_col: "volume_cum_usd_e6"  },
    ]
    for (const check of rollupChecks) {
      const r = await client.query<{ id: number; slug: string; cached: string | null; actual: string }>(
        `SELECT p.id, p.slug,
                p.${check.cached_col}::text AS cached,
                COALESCE(SUM(r.amount_usd_e6), 0)::text AS actual
         FROM projects p
         LEFT JOIN ${check.table} r ON r.project_id = p.id
         WHERE p.tvl_tracking_enabled = true
         GROUP BY p.id, p.${check.cached_col}
         HAVING p.${check.cached_col} IS DISTINCT FROM COALESCE(SUM(r.amount_usd_e6), 0)`,
      )
      for (const row of r.rows) {
        const cached = row.cached ? BigInt(row.cached) : BigInt(0)
        const actual = BigInt(row.actual)
        if (!exceedsDriftTolerance(cached, actual)) continue
        await recordAlert(client, row.id, `${check.kind}_rollup_drift`, "warning",
          `${row.slug}: cached ${check.kind}_cum $${(Number(cached) / 1e6).toFixed(2)} does not equal SUM of ${check.table} $${(Number(actual) / 1e6).toFixed(2)}`,
          { cached: cached.toString(), actual: actual.toString() },
          `rollup:${check.kind}:${row.id}`,
        )
        stats.rollupAlerts++
        stats.totalAlerts++
      }
    }

    // ─── CHECK 4: cursor staleness ──────────────────────────────────────────
    // The indexer expects cursors to advance every tick. If a cursor is
    // more than 1000 blocks behind head, something is stuck — either Arc
    // RPC is down, getLogs is rate-limited, or a downstream write keeps
    // failing.
    const STALE_GAP = 1000
    const stale = await client.query<{ kind: string; stablecoin_id: number; last_block: string; updated_at: string }>(
      `SELECT kind, stablecoin_id, last_block::text, updated_at
       FROM indexer_cursors
       WHERE $1::bigint - last_block > $2::bigint`,
      [String(stats.head), String(STALE_GAP)],
    )
    for (const row of stale.rows) {
      const lag = stats.head - Number(row.last_block)
      await recordAlert(client, null, "cursor_stale", "warning",
        `Cursor ${row.kind}/sc${row.stablecoin_id} is ${lag.toLocaleString()} blocks behind head — indexer may be stuck`,
        { kind: row.kind, stablecoin_id: row.stablecoin_id, lag, last_block: row.last_block, head: stats.head },
        `cursor:${row.kind}:${row.stablecoin_id}`,
      )
      stats.cursorAlerts++
      stats.totalAlerts++
    }

    // ─── CHECK 5: forex freshness ───────────────────────────────────────────
    // If any active stablecoin pegs to a non-USD currency, that currency's
    // forex rate must have a row dated within the last 48h. Otherwise we'd
    // silently use a stale conversion.
    const stalefx = await client.query<{ peg_currency: string; last_rate_date: string | null }>(
      `SELECT DISTINCT s.peg_currency,
              (SELECT MAX(f.effective_date)::text
               FROM forex_rates f WHERE f.currency = s.peg_currency) AS last_rate_date
       FROM stablecoins s
       WHERE s.active = true AND s.peg_currency <> 'USD'`,
    )
    // ECB (our forex source) only publishes on weekdays, so a Friday rate is
    // legitimately ~72h old by Monday. Tolerate the weekend gap: 80h threshold
    // on Sat/Sun/Mon, 48h on normal weekdays — so a real provider outage still
    // alerts within 2 days without crying wolf every weekend.
    const dow = new Date().getUTCDay() // 0=Sun … 6=Sat
    const thresholdMs = (dow === 0 || dow === 6 || dow === 1 ? 80 : 48) * 60 * 60 * 1000
    for (const row of stalefx.rows) {
      const stale =
        !row.last_rate_date ||
        (Date.now() - new Date(row.last_rate_date).getTime() > thresholdMs)
      if (!stale) continue
      await recordAlert(client, null, "forex_stale", "warning",
        `No fresh forex rate for ${row.peg_currency} — non-USD stablecoin conversions are using the ${row.last_rate_date ?? "no"} rate.`,
        { currency: row.peg_currency, last_rate_date: row.last_rate_date },
        `forex:${row.peg_currency}`,
      )
      stats.forexAlerts++
      stats.totalAlerts++
    }

    stats.elapsedMs = Date.now() - startedAt
    return NextResponse.json({ ok: true, ...stats })
  } catch (e: any) {
    stats.elapsedMs = Date.now() - startedAt
    console.error("[tvl-drift cron] fatal:", e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), ...stats },
      { status: 500 },
    )
  } finally {
    client.release()
  }
}
