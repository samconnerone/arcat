// src/app/api/cron/tvl-revenue/route.ts
//
// The single, combined TVL & revenue indexer. Vercel Cron hits this every
// 5 minutes. Handles every active project in one pass.
//
// Design notes:
//   • One getLogs call per stablecoin per tick (topic-filtered to every tracked
//     revenue contract) → captures every fee inflow exactly once.
//   • One balanceOf call per (live TVL contract, stablecoin) at latest-6 →
//     gives the deterministic source-of-truth balance. No event-derived cache
//     can drift from this. Reorg-safe via the 6-block buffer.
//   • A snapshot row is only written when a project's total changes — keeps
//     the snapshots table compact.
//   • Materialized columns on `projects` are updated in the same transaction
//     so the ecosystem grid stays a one-query fast path.
//   • Adaptive early-exit: if no new blocks since last cursor, the function
//     returns in < 500ms with zero RPC calls. Most weekend ticks will hit this.
//   • Errors per-project are caught and recorded to `indexer_alerts`. The
//     cron never throws — one bad project should not stall the whole pipeline.

import { NextRequest, NextResponse } from "next/server"
import { PoolClient } from "pg"
import { ethers } from "ethers"

import { ARC_RPC_HTTP } from "@/lib/constants"
import { getPool } from "@/lib/dbPool"
import {
  TRANSFER_TOPIC,
  ERC20_BALANCE_ABI,
  REORG_BUFFER,
  MAX_LOG_RANGE,
  addressToTopic,
  topicToAddress,
  toUsdE6,
  dataArgTypes,
  getLogsBisecting,
  type StablecoinRow,
  type ProjectContractRow,
  type ForexMap,
} from "@/lib/tvl"

export const runtime = "nodejs"
export const maxDuration = 300 // Fluid Compute budget; we'll usually finish in seconds

const pool = getPool()

// Arc's public RPC caps at ~100 req/sec. We run getBlock requests through
// this gate so a busy log window can't burst past that. Each tick across all
// projects is ~one indexer process, so a single shared limit is enough.
async function gatedAll<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}

// Arc's public RPC (QuickNode) rate-limits at ~100 req/sec (-32007) and, under
// load, sometimes returns an empty body that ethers surfaces as a bogus
// CALL_EXCEPTION / "could not coalesce". Both are transient — retry the single
// call with backoff before letting it propagate. Getlogs has its own bisecting
// backoff; this covers getBlock + balanceOf.
const TRANSIENT_RPC = /-32007|request limit reached|reduce calls per second|rate.?limit|too many requests|\b429\b|could not coalesce|missing revert data|timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i
async function rlRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: any
  for (let i = 0; i < attempts; i++) {
    try { return await fn() }
    catch (e: any) {
      last = e
      const msg = e?.error?.message || e?.info?.error?.message || e?.shortMessage || e?.message || String(e)
      if (i < attempts - 1 && TRANSIENT_RPC.test(msg)) {
        await new Promise(r => setTimeout(r, 300 * 2 ** i + Math.floor(Math.random() * 200)))
        continue
      }
      throw e
    }
  }
  throw last
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const got = req.headers.get("authorization")
  return got === `Bearer ${expected}`
}

// ─── ENTRYPOINT ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()
  const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
  const client = await pool.connect()

  const stats = {
    targetBlock: 0,
    stablecoinsScanned: 0,
    newRevenueEvents: 0,
    newVolumeEvents: 0,
    volumeContractsScanned: 0,
    projectsIndexed: 0,
    snapshotsWritten: 0,
    athUpdated: 0,
    alerts: 0,
    earlyExit: false,
    elapsedMs: 0,
  }

  // Small retry helper — Arc's public RPC blinks occasionally. One retry
  // with backoff is enough to absorb transient timeouts; on sustained failure
  // we record an alert and return 200 so Vercel doesn't mark the cron as a
  // hard failure (the next 5-min tick will retry naturally).
  async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
    let lastErr: any
    for (let i = 1; i <= attempts; i++) {
      try { return await fn() }
      catch (e) {
        lastErr = e
        if (i < attempts) await new Promise(r => setTimeout(r, 1500))
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${(lastErr as any)?.message || lastErr}`)
  }

  try {
    // 1. Determine the safe head block — with retry against flaky RPC.
    let latest: number
    try {
      latest = await withRetry("getBlockNumber", () => provider.getBlockNumber())
    } catch (e: any) {
      await recordAlert(client, null, "rpc_error", "warning",
        `Indexer: ${e?.message || e}`)
      stats.alerts++
      stats.elapsedMs = Date.now() - startedAt
      return NextResponse.json({ ok: true, reason: "rpc_unavailable", ...stats })
    }
    const targetBlock = Math.max(0, latest - REORG_BUFFER)
    stats.targetBlock = targetBlock

    // 2. Load registry data.
    const stables = await loadActiveStablecoins(client)
    const contracts = await loadLiveProjectContracts(client)
    const forex = await loadTodaysForex(client)

    if (stables.length === 0 || contracts.length === 0) {
      stats.earlyExit = true
      stats.elapsedMs = Date.now() - startedAt
      return NextResponse.json({ ok: true, reason: "no_work", ...stats })
    }

    // 3. Per-stablecoin event scan for revenue events.
    for (const s of stables) {
      try {
        const count = await scanStablecoinRevenueEvents(
          client, provider, s, contracts, forex, targetBlock,
        )
        stats.newRevenueEvents += count
        stats.stablecoinsScanned++
      } catch (e: any) {
        await recordAlert(client, null, "rpc_error", "warning",
          `Revenue scan failed for ${s.symbol}: ${e?.message || e}`)
        stats.alerts++
      }
    }

    // 4. Compute current TVL for every project from balanceOf at targetBlock.
    const projectIds = Array.from(new Set(contracts.map(c => c.project_id)))
    let blockMeta: ethers.Block | null = null
    try {
      blockMeta = await withRetry(`getBlock(${targetBlock})`, () => provider.getBlock(targetBlock))
    } catch (e: any) {
      // Fall back to current wall time for the snapshot — not perfect but
      // consistent within the tick. Record the issue.
      await recordAlert(client, null, "rpc_error", "warning",
        `Indexer: ${e?.message || e}; using wall-clock for block_time`)
      stats.alerts++
    }
    const blockTimestamp = blockMeta ? new Date(blockMeta.timestamp * 1000) : new Date()

    for (const projectId of projectIds) {
      try {
        const r = await indexProjectTvl(
          client, provider, projectId, contracts, stables, forex,
          targetBlock, blockTimestamp,
        )
        stats.projectsIndexed++
        if (r.snapshotWritten) stats.snapshotsWritten++
        if (r.athUpdated) stats.athUpdated++
      } catch (e: any) {
        await recordAlert(client, projectId, "tvl_error", "warning",
          `TVL index failed: ${e?.message || e}`)
        stats.alerts++
      }
    }

    // 5. Per-volume-contract event scan. Each volume contract carries its
    //    own event signature + arg config, so we scan them individually
    //    rather than batching by stablecoin (signatures vary per protocol).
    const volumeContracts = contracts.filter(c => c.role === "volume")
    for (const vc of volumeContracts) {
      try {
        const stable = stables.find(s => s.id === vc.volume_stablecoin_id)
        if (!stable) {
          await recordAlert(client, vc.project_id, "volume_config", "warning",
            `Volume contract ${vc.address}: stablecoin_id=${vc.volume_stablecoin_id} not in active registry — skipping.`)
          stats.alerts++
          continue
        }
        // Two volume methods supported:
        //   • 'swap_event'       → decode the founder's declared Swap event (precise)
        //   • 'outflow_transfer' → sum USDC Transfer events FROM the contract (approximate)
        // For backwards compatibility, NULL method is treated as 'swap_event'.
        const method = vc.volume_method ?? "swap_event"
        if (method === "swap_event") {
          if (!vc.volume_event_topic || vc.volume_amount_arg == null || !vc.volume_event_signature) {
            await recordAlert(client, vc.project_id, "volume_config", "warning",
              `Volume contract ${vc.address}: event_signature / amount_arg / topic missing for swap_event mode — skipping.`)
            stats.alerts++
            continue
          }
          const count = await scanVolumeEvents(
            client, provider, vc, stable, forex, targetBlock,
          )
          stats.newVolumeEvents += count
        } else if (method === "outflow_transfer") {
          const count = await scanVolumeOutflow(
            client, provider, vc, stable, forex, targetBlock,
          )
          stats.newVolumeEvents += count
        } else {
          await recordAlert(client, vc.project_id, "volume_config", "warning",
            `Volume contract ${vc.address}: unknown volume_method ${method} — skipping.`)
          stats.alerts++
          continue
        }
        stats.volumeContractsScanned++
      } catch (e: any) {
        await recordAlert(client, vc.project_id, "rpc_error", "warning",
          `Volume scan failed for ${vc.address}: ${e?.message || e}`)
        stats.alerts++
      }
    }

    // 6. Roll up revenue + volume totals onto `projects` for fast leaderboard reads.
    await rollupRevenueOntoProjects(client, projectIds)
    await rollupVolumeOntoProjects(client, projectIds)

    stats.elapsedMs = Date.now() - startedAt
    return NextResponse.json({ ok: true, ...stats })
  } catch (e: any) {
    stats.elapsedMs = Date.now() - startedAt
    console.error("[tvl-revenue cron] fatal:", e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), ...stats },
      { status: 500 },
    )
  } finally {
    client.release()
  }
}

// ─── DATA LOADERS ────────────────────────────────────────────────────────────
async function loadActiveStablecoins(client: PoolClient): Promise<StablecoinRow[]> {
  const r = await client.query<StablecoinRow>(
    `SELECT id, LOWER(address) AS address, symbol, decimals, peg_currency
     FROM stablecoins WHERE active = true ORDER BY id`,
  )
  return r.rows
}

async function loadLiveProjectContracts(client: PoolClient): Promise<ProjectContractRow[]> {
  // Live = founder-verified by deployer sig, not revoked.
  // Joins `projects` to also exclude unapproved / hidden projects.
  const r = await client.query<ProjectContractRow>(
    `SELECT pc.id, pc.project_id, LOWER(pc.address) AS address, pc.role,
            pc.label, pc.start_block,
            pc.volume_event_signature, pc.volume_event_topic,
            pc.volume_amount_arg, pc.volume_stablecoin_id,
            pc.volume_method
     FROM project_contracts pc
     JOIN projects p ON p.id = pc.project_id
     WHERE pc.verified_at IS NOT NULL
       AND pc.revoked_at IS NULL
       AND p.approved = true
       AND p.live = true
       AND p.tvl_tracking_enabled = true
     ORDER BY pc.project_id, pc.id`,
  )
  return r.rows
}

async function loadTodaysForex(client: PoolClient): Promise<ForexMap> {
  // Latest effective rate per currency, on or before today.
  const r = await client.query<{
    currency: string; rate_to_usd: string; effective_date: string; source: string
  }>(
    `SELECT DISTINCT ON (currency)
            currency, rate_to_usd::text, effective_date::text, source
     FROM forex_rates
     WHERE effective_date <= CURRENT_DATE
     ORDER BY currency, effective_date DESC`,
  )
  const out: ForexMap = {}
  for (const row of r.rows) {
    out[row.currency] = {
      rate: Number(row.rate_to_usd),
      effective_date: row.effective_date,
      source: row.source,
    }
  }
  // Safety: USD must always be 1.0.
  if (!out.USD) out.USD = { rate: 1, effective_date: "synthetic", source: "hardcoded" }
  return out
}

// ─── REVENUE EVENT SCAN ──────────────────────────────────────────────────────
async function scanStablecoinRevenueEvents(
  client: PoolClient,
  provider: ethers.JsonRpcProvider,
  s: StablecoinRow,
  contracts: ProjectContractRow[],
  forex: ForexMap,
  targetBlock: number,
): Promise<number> {
  const revenueContracts = contracts.filter(c => c.role === "revenue")
  if (revenueContracts.length === 0) return 0

  // Cursor: last block we already ingested for this stablecoin.
  const curRes = await client.query<{ last_block: string }>(
    `SELECT last_block::text FROM indexer_cursors
     WHERE kind = 'tvl_revenue' AND stablecoin_id = $1`,
    [s.id],
  )
  const cursor = curRes.rows[0] ? Number(curRes.rows[0].last_block) : 0

  if (cursor >= targetBlock) return 0 // nothing new

  const fromBlock = cursor + 1
  const toBlock = Math.min(targetBlock, fromBlock + MAX_LOG_RANGE - 1)

  // Topic filter: Transfer(*, [revenueContracts]) — inflows only.
  // Uses bisecting getLogs so an unusually busy window auto-splits
  // when Arc RPC returns the "exceeds max results" error.
  const toTopics = revenueContracts.map(c => addressToTopic(c.address))
  const logs = await getLogsBisecting(
    provider,
    { address: s.address, topics: [TRANSFER_TOPIC, null, toTopics] },
    fromBlock, toBlock,
  )

  // Build a fast (lowercase address → contract row) lookup.
  const revByAddr = new Map<string, ProjectContractRow>()
  for (const c of revenueContracts) revByAddr.set(c.address, c)

  // Pre-fetch block timestamps. Concurrency-gated to stay under Arc RPC's
  // 100/sec cap when revenue events span many distinct blocks.
  const blockNums = Array.from(new Set(logs.map(l => l.blockNumber)))
  const blockTimes = new Map<number, Date>()
  await gatedAll(blockNums, 6, async n => {
    // Non-fatal: a rate-limited block-time fetch must not abort the whole scan
    // (that froze the cursor and re-failed every tick). Retry, then fall back to
    // wall-clock for this block's events if it still won't come.
    try {
      const b = await rlRetry(() => provider.getBlock(n))
      if (b) blockTimes.set(n, new Date(b.timestamp * 1000))
    } catch { /* fall back to wall-clock for this block */ }
  })

  const fx = forex[s.peg_currency] ?? forex.USD

  // Collect into in-memory buffers; flush as one bulk INSERT to keep DB
  // round-trips constant regardless of log volume.
  type RevenueRow = [
    proj: number, contract: number, sc: number,
    tx: string, idx: number, blk: number, ts: Date,
    fromAddr: string, rawStr: string, usdStr: string,
  ]
  const rows: RevenueRow[] = []
  for (const log of logs) {
    const toAddr = topicToAddress(log.topics[2])
    const contract = revByAddr.get(toAddr)
    if (!contract) continue
    if (log.blockNumber < contract.start_block) continue

    const rawAmount = BigInt(log.data)
    const usdE6 = toUsdE6(rawAmount, s.decimals, fx.rate)
    const fromAddr = topicToAddress(log.topics[1])
    const blockTime = blockTimes.get(log.blockNumber) ?? new Date()

    rows.push([
      contract.project_id, contract.id, s.id,
      log.transactionHash, log.index, log.blockNumber, blockTime,
      fromAddr, rawAmount.toString(), usdE6.toString(),
    ])
  }

  let inserted = 0
  const dailyDeltas = new Map<string, { usdE6: bigint; count: number }>()
  if (rows.length > 0) {
    const placeholders: string[] = []
    const flat: any[] = []
    rows.forEach((row, i) => {
      const off = i * 10
      placeholders.push(
        `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9},$${off + 10})`,
      )
      flat.push(...row)
    })
    const r = await client.query<{ project_id: number; block_time: string; amount_usd_e6: string }>(
      `INSERT INTO revenue_events
         (project_id, contract_id, stablecoin_id, tx_hash, log_index,
          block_number, block_time, from_address, amount_raw, amount_usd_e6)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING project_id, block_time::text, amount_usd_e6::text`,
      flat,
    )
    inserted = r.rowCount ?? 0
    // Only freshly inserted rows feed the daily rollup → idempotent on retry.
    for (const row of r.rows) {
      const day = String(row.block_time).slice(0, 10)
      const k = `${row.project_id}|${day}`
      const cur = dailyDeltas.get(k) ?? { usdE6: BigInt(0), count: 0 }
      cur.usdE6 += BigInt(row.amount_usd_e6)
      cur.count += 1
      dailyDeltas.set(k, cur)
    }
  }

  for (const [k, { usdE6, count }] of dailyDeltas) {
    const [projStr, day] = k.split("|")
    await client.query(
      `INSERT INTO revenue_daily (project_id, day, total_usd_e6, event_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, day) DO UPDATE SET
         total_usd_e6 = revenue_daily.total_usd_e6 + EXCLUDED.total_usd_e6,
         event_count  = revenue_daily.event_count + EXCLUDED.event_count,
         updated_at   = NOW()`,
      [Number(projStr), day, usdE6.toString(), count],
    )
  }

  // Advance cursor only after successful write.
  await client.query(
    `INSERT INTO indexer_cursors (kind, stablecoin_id, last_block, updated_at)
     VALUES ('tvl_revenue', $1, $2, NOW())
     ON CONFLICT (kind, stablecoin_id) DO UPDATE SET
       last_block = EXCLUDED.last_block,
       updated_at = NOW()`,
    [s.id, toBlock],
  )

  return inserted
}

// ─── PER-PROJECT TVL ─────────────────────────────────────────────────────────
async function indexProjectTvl(
  client: PoolClient,
  provider: ethers.JsonRpcProvider,
  projectId: number,
  allContracts: ProjectContractRow[],
  stables: StablecoinRow[],
  forex: ForexMap,
  targetBlock: number,
  blockTime: Date,
): Promise<{ snapshotWritten: boolean; athUpdated: boolean }> {
  // Only TVL contracts contribute to TVL. Revenue events are tracked separately.
  const tvlContracts = allContracts.filter(
    c => c.project_id === projectId && c.role === "tvl",
  )
  if (tvlContracts.length === 0) {
    return { snapshotWritten: false, athUpdated: false }
  }

  // Compute current balance per (contract, stablecoin) at targetBlock.
  // Parallelized — small N, all reads to the same RPC.
  type Cell = {
    contract: ProjectContractRow
    stablecoin: StablecoinRow
    balanceRaw: bigint
    usdE6: bigint
  }
  const cells: Cell[] = []
  await Promise.all(
    tvlContracts.flatMap(c =>
      stables.map(async s => {
        if (targetBlock < c.start_block) return // contract not deployed yet
        const erc20 = new ethers.Contract(s.address, ERC20_BALANCE_ABI, provider)
        const balanceRaw: bigint = await rlRetry(() => erc20.balanceOf(c.address, { blockTag: targetBlock }))
        if (balanceRaw === BigInt(0)) return // skip empty pairs to keep snapshot lean
        const fx = forex[s.peg_currency] ?? forex.USD
        const usdE6 = toUsdE6(balanceRaw, s.decimals, fx.rate)
        cells.push({ contract: c, stablecoin: s, balanceRaw, usdE6 })
      }),
    ),
  )

  const totalUsdE6 = cells.reduce((acc, c) => acc + c.usdE6, BigInt(0))

  // Read the prior cached total — only snapshot when something changed.
  const prior = await client.query<{
    tvl_usd_e6: string | null
    tvl_ath_usd_e6: string | null
  }>(
    `SELECT tvl_usd_e6::text, tvl_ath_usd_e6::text FROM projects WHERE id = $1`,
    [projectId],
  )
  const priorTotal = prior.rows[0]?.tvl_usd_e6 ? BigInt(prior.rows[0].tvl_usd_e6) : null
  const priorAth = prior.rows[0]?.tvl_ath_usd_e6 ? BigInt(prior.rows[0].tvl_ath_usd_e6) : BigInt(0)

  let snapshotWritten = false
  if (priorTotal === null || priorTotal !== totalUsdE6) {
    const breakdown = cells.map(c => ({
      contract_id: c.contract.id,
      contract_address: c.contract.address,
      contract_label: c.contract.label,
      stablecoin_id: c.stablecoin.id,
      symbol: c.stablecoin.symbol,
      balance_raw: c.balanceRaw.toString(),
      usd_e6: c.usdE6.toString(),
    }))
    await client.query(
      `INSERT INTO tvl_snapshots (project_id, block_number, block_time, total_usd_e6, breakdown)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [projectId, targetBlock, blockTime, totalUsdE6.toString(), JSON.stringify(breakdown)],
    )
    snapshotWritten = true
  }

  // Materialize onto `projects` for fast leaderboard.
  const athUpdated = totalUsdE6 > priorAth
  if (athUpdated) {
    await client.query(
      `UPDATE projects SET
         tvl_usd_e6 = $2,
         tvl_ath_usd_e6 = $2,
         tvl_ath_block = $3,
         tvl_ath_at = $4,
         tvl_last_indexed_at = NOW()
       WHERE id = $1`,
      [projectId, totalUsdE6.toString(), targetBlock, blockTime],
    )
  } else {
    await client.query(
      `UPDATE projects SET
         tvl_usd_e6 = $2,
         tvl_last_indexed_at = NOW()
       WHERE id = $1`,
      [projectId, totalUsdE6.toString()],
    )
  }

  return { snapshotWritten, athUpdated }
}

// ─── REVENUE ROLLUPS ─────────────────────────────────────────────────────────
async function rollupRevenueOntoProjects(client: PoolClient, projectIds: number[]) {
  if (projectIds.length === 0) return
  // Drive the UPDATE from `projects` so a project that USED to have events
  // but no longer does (contract revoked / cascade-deleted) gets reset to 0
  // instead of keeping a stale cached cumulative. The LEFT JOIN to the
  // computed sums means projects with no rows end up with COALESCE(..., 0).
  await client.query(
    `UPDATE projects p SET
       revenue_cum_usd_e6     = COALESCE(t.cum, 0),
       revenue_ath_day_usd_e6 = ath.max_day,
       revenue_ath_day        = ath.max_date
     FROM (SELECT unnest($1::int[]) AS project_id) ids
     LEFT JOIN LATERAL (
       SELECT SUM(amount_usd_e6) AS cum
       FROM revenue_events WHERE project_id = ids.project_id
     ) t ON true
     LEFT JOIN LATERAL (
       SELECT day AS max_date, total_usd_e6 AS max_day
       FROM revenue_daily rd
       WHERE rd.project_id = ids.project_id
       ORDER BY rd.total_usd_e6 DESC LIMIT 1
     ) ath ON true
     WHERE p.id = ids.project_id`,
    [projectIds],
  )
}

// ─── VOLUME SCAN ─────────────────────────────────────────────────────────────
// Precise: decodes the founder-declared Swap event from the contract's logs,
// pulls the amount at the configured arg position, converts to USD-e6 via
// the configured stablecoin's decimals + that currency's forex rate.
//
// Idempotent on re-runs via UNIQUE (tx_hash, log_index). Cursor advances
// only after successful write — partial failures get retried next tick.
async function scanVolumeEvents(
  client: PoolClient,
  provider: ethers.JsonRpcProvider,
  vc: ProjectContractRow,
  stable: StablecoinRow,
  forex: ForexMap,
  targetBlock: number,
): Promise<number> {
  // Per-contract cursor — encoded as kind="volume_${contract_id}". Each
  // volume contract has its own event signature so they can't share a
  // getLogs call; per-contract cursors mean a contract registered LATER with
  // an OLDER start_block still gets fully backfilled from start_block
  // forward, instead of being skipped because some other contract's cursor
  // had already advanced.
  const cursorKind = `volume_${vc.id}`
  const curRes = await client.query<{ last_block: string }>(
    `SELECT last_block::text FROM indexer_cursors
     WHERE kind = $1 AND stablecoin_id = $2`,
    [cursorKind, stable.id],
  )
  const cursor = curRes.rows[0] ? Number(curRes.rows[0].last_block) : 0
  if (cursor >= targetBlock) return 0

  // First-scan backfill: when cursor=0 (or older than start_block), start at
  // start_block. Otherwise resume where we left off.
  const fromBlock = Math.max(cursor + 1, vc.start_block)
  if (fromBlock > targetBlock) return 0
  const toBlock = Math.min(targetBlock, fromBlock + MAX_LOG_RANGE - 1)

  // One contract, one topic. We still bisect because a popular DEX could
  // emit >20k Swap events in a 5,000-block window even with a narrow filter.
  const logs = await getLogsBisecting(
    provider,
    { address: vc.address, topics: [vc.volume_event_topic!] },
    fromBlock, toBlock,
  )

  if (logs.length === 0) {
    await client.query(
      `INSERT INTO indexer_cursors (kind, stablecoin_id, last_block, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (kind, stablecoin_id) DO UPDATE SET
         last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block),
         updated_at = NOW()`,
      [cursorKind, stable.id, toBlock],
    )
    return 0
  }

  // Decode the data section using only the non-indexed arg types — the
  // founder provides the full Solidity signature (with `indexed` keywords);
  // dataArgTypes() filters down to the exact set of types present in log.data.
  const argTypes = dataArgTypes(vc.volume_event_signature!)
  if (argTypes.length === 0) {
    throw new Error(
      `volume_event_signature has no non-indexed args (nothing to decode): ${vc.volume_event_signature}`,
    )
  }
  const coder = ethers.AbiCoder.defaultAbiCoder()
  const amountIdx = vc.volume_amount_arg!
  if (amountIdx >= argTypes.length) {
    throw new Error(
      `volume_amount_arg=${amountIdx} out of range — only ${argTypes.length} non-indexed args in ${vc.volume_event_signature}`,
    )
  }

  // Pre-fetch block timestamps. Concurrency-gated so we never burst past
  // Arc's 100/sec public-RPC cap on busy windows.
  const blockNums = Array.from(new Set(logs.map(l => l.blockNumber)))
  const blockTimes = new Map<number, Date>()
  await gatedAll(blockNums, 6, async n => {
    // Non-fatal: a rate-limited block-time fetch must not abort the whole scan
    // (that froze the cursor and re-failed every tick). Retry, then fall back to
    // wall-clock for this block's events if it still won't come.
    try {
      const b = await rlRetry(() => provider.getBlock(n))
      if (b) blockTimes.set(n, new Date(b.timestamp * 1000))
    } catch { /* fall back to wall-clock for this block */ }
  })

  const fx = forex[stable.peg_currency] ?? forex.USD

  // Decode + collect into in-memory buffers so we can flush with ONE
  // bulk INSERT for events and ONE upsert per (project,day) bucket.
  // Avoids 2 DB round-trips per log — critical when the DB is across the
  // ocean from the function (eg. Supabase eu-west-1 + a different region).
  type EventRow = [
    proj: number, contract: number, sc: number,
    tx: string, idx: number, blk: number, ts: Date,
    rawStr: string, usdStr: string,
  ]
  const eventRows: EventRow[] = []
  const dailyKey = (proj: number, day: string) => `${proj}|${day}`

  for (const log of logs) {
    let amount: bigint
    try {
      const decoded = coder.decode(argTypes, log.data)
      const val = decoded[amountIdx]
      amount = typeof val === "bigint" ? val : BigInt(val)
      if (amount < BigInt(0)) amount = -amount // int256 swap deltas
    } catch {
      continue
    }
    if (amount === BigInt(0)) continue

    const usdE6 = toUsdE6(amount, stable.decimals, fx.rate)
    const blockTime = blockTimes.get(log.blockNumber) ?? new Date()

    eventRows.push([
      vc.project_id, vc.id, stable.id,
      log.transactionHash, log.index, log.blockNumber, blockTime,
      amount.toString(), usdE6.toString(),
    ])
  }

  let inserted = 0
  // Only the events actually inserted (not duplicates) drive the daily
  // rollup — otherwise a retried/interrupted run would double-count.
  const insertedDeltas = new Map<string, { usdE6: bigint; count: number }>()

  if (eventRows.length > 0) {
    // Postgres caps at 65,535 params per statement; 9 params/row → 7,281
    // rows max, well above any realistic 5-min window.
    const placeholders: string[] = []
    const flat: any[] = []
    eventRows.forEach((row, i) => {
      const off = i * 9
      placeholders.push(
        `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9})`,
      )
      flat.push(...row)
    })
    const r = await client.query<{ project_id: number; block_time: string; amount_usd_e6: string }>(
      `INSERT INTO volume_events
         (project_id, contract_id, stablecoin_id, tx_hash, log_index,
          block_number, block_time, amount_raw, amount_usd_e6)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING project_id, block_time::text, amount_usd_e6::text`,
      flat,
    )
    inserted = r.rowCount ?? 0
    for (const row of r.rows) {
      const day = String(row.block_time).slice(0, 10)
      const k = dailyKey(row.project_id, day)
      const cur = insertedDeltas.get(k) ?? { usdE6: BigInt(0), count: 0 }
      cur.usdE6 += BigInt(row.amount_usd_e6)
      cur.count += 1
      insertedDeltas.set(k, cur)
    }
  }

  // One upsert per (project, day) — at most ~7 rows even on busy days.
  for (const [k, { usdE6, count }] of insertedDeltas) {
    const [projStr, day] = k.split("|")
    await client.query(
      `INSERT INTO volume_daily (project_id, day, total_usd_e6, event_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, day) DO UPDATE SET
         total_usd_e6 = volume_daily.total_usd_e6 + EXCLUDED.total_usd_e6,
         event_count  = volume_daily.event_count + EXCLUDED.event_count,
         updated_at   = NOW()`,
      [Number(projStr), day, usdE6.toString(), count],
    )
  }

  await client.query(
    `INSERT INTO indexer_cursors (kind, stablecoin_id, last_block, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (kind, stablecoin_id) DO UPDATE SET
       last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block),
       updated_at = NOW()`,
    [cursorKind, stable.id, toBlock],
  )

  return inserted
}

// ─── VOLUME SCAN (outflow-transfer method) ───────────────────────────────────
// Approximate but no protocol-specific event decoding. For aggregator-shape
// contracts (Tower, 1inch, Paraswap) whose routers don't emit Swap events.
//
// Heuristic: every successful swap routed through the contract eventually
// transfers stables OUT of the router back to the user. We sum those
// Transfer-OUT events on the configured stablecoin. Over-counts internal
// hops; UI labels the resulting number as "approximate".
async function scanVolumeOutflow(
  client: PoolClient,
  provider: ethers.JsonRpcProvider,
  vc: ProjectContractRow,
  stable: StablecoinRow,
  forex: ForexMap,
  targetBlock: number,
): Promise<number> {
  const cursorKind = `volume_${vc.id}`
  const curRes = await client.query<{ last_block: string }>(
    `SELECT last_block::text FROM indexer_cursors
     WHERE kind = $1 AND stablecoin_id = $2`,
    [cursorKind, stable.id],
  )
  const cursor = curRes.rows[0] ? Number(curRes.rows[0].last_block) : 0
  if (cursor >= targetBlock) return 0

  const fromBlock = Math.max(cursor + 1, vc.start_block)
  if (fromBlock > targetBlock) return 0
  const toBlock = Math.min(targetBlock, fromBlock + MAX_LOG_RANGE - 1)

  // Filter: Transfer events on the stablecoin where `from` = our contract.
  // topic[1] = from-address (indexed), padded to 32 bytes.
  const fromTopic = addressToTopic(vc.address)
  const logs = await getLogsBisecting(
    provider,
    { address: stable.address, topics: [TRANSFER_TOPIC, fromTopic] },
    fromBlock, toBlock,
  )

  if (logs.length === 0) {
    await client.query(
      `INSERT INTO indexer_cursors (kind, stablecoin_id, last_block, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (kind, stablecoin_id) DO UPDATE SET
         last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block),
         updated_at = NOW()`,
      [cursorKind, stable.id, toBlock],
    )
    return 0
  }

  // Pre-fetch block timestamps, concurrency-gated.
  const blockNums = Array.from(new Set(logs.map(l => l.blockNumber)))
  const blockTimes = new Map<number, Date>()
  await gatedAll(blockNums, 6, async n => {
    // Non-fatal: a rate-limited block-time fetch must not abort the whole scan
    // (that froze the cursor and re-failed every tick). Retry, then fall back to
    // wall-clock for this block's events if it still won't come.
    try {
      const b = await rlRetry(() => provider.getBlock(n))
      if (b) blockTimes.set(n, new Date(b.timestamp * 1000))
    } catch { /* fall back to wall-clock for this block */ }
  })

  const fx = forex[stable.peg_currency] ?? forex.USD

  type EventRow = [
    proj: number, contract: number, sc: number,
    tx: string, idx: number, blk: number, ts: Date,
    rawStr: string, usdStr: string,
  ]
  const eventRows: EventRow[] = []
  const dailyKey = (proj: number, day: string) => `${proj}|${day}`

  for (const log of logs) {
    const amount = BigInt(log.data) // unindexed value in Transfer payload
    if (amount === BigInt(0)) continue
    const usdE6 = toUsdE6(amount, stable.decimals, fx.rate)
    const blockTime = blockTimes.get(log.blockNumber) ?? new Date()
    eventRows.push([
      vc.project_id, vc.id, stable.id,
      log.transactionHash, log.index, log.blockNumber, blockTime,
      amount.toString(), usdE6.toString(),
    ])
  }

  let inserted = 0
  const insertedDeltas = new Map<string, { usdE6: bigint; count: number }>()
  if (eventRows.length > 0) {
    const placeholders: string[] = []
    const flat: any[] = []
    eventRows.forEach((row, i) => {
      const off = i * 9
      placeholders.push(
        `($${off + 1},$${off + 2},$${off + 3},$${off + 4},$${off + 5},$${off + 6},$${off + 7},$${off + 8},$${off + 9})`,
      )
      flat.push(...row)
    })
    const r = await client.query<{ project_id: number; block_time: string; amount_usd_e6: string }>(
      `INSERT INTO volume_events
         (project_id, contract_id, stablecoin_id, tx_hash, log_index,
          block_number, block_time, amount_raw, amount_usd_e6)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING project_id, block_time::text, amount_usd_e6::text`,
      flat,
    )
    inserted = r.rowCount ?? 0
    for (const row of r.rows) {
      const day = String(row.block_time).slice(0, 10)
      const k = dailyKey(row.project_id, day)
      const cur = insertedDeltas.get(k) ?? { usdE6: BigInt(0), count: 0 }
      cur.usdE6 += BigInt(row.amount_usd_e6)
      cur.count += 1
      insertedDeltas.set(k, cur)
    }
  }

  for (const [k, { usdE6, count }] of insertedDeltas) {
    const [projStr, day] = k.split("|")
    await client.query(
      `INSERT INTO volume_daily (project_id, day, total_usd_e6, event_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, day) DO UPDATE SET
         total_usd_e6 = volume_daily.total_usd_e6 + EXCLUDED.total_usd_e6,
         event_count  = volume_daily.event_count + EXCLUDED.event_count,
         updated_at   = NOW()`,
      [Number(projStr), day, usdE6.toString(), count],
    )
  }

  await client.query(
    `INSERT INTO indexer_cursors (kind, stablecoin_id, last_block, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (kind, stablecoin_id) DO UPDATE SET
       last_block = GREATEST(indexer_cursors.last_block, EXCLUDED.last_block),
       updated_at = NOW()`,
    [cursorKind, stable.id, toBlock],
  )

  return inserted
}

async function rollupVolumeOntoProjects(client: PoolClient, projectIds: number[]) {
  if (projectIds.length === 0) return
  // Same correctness fix as the revenue rollup — UPDATE driven from
  // `projects`, with LEFT JOIN against events. Projects with no events
  // get reset to 0 instead of holding a stale cached cumulative.
  await client.query(
    `UPDATE projects p SET
       volume_cum_usd_e6     = COALESCE(t.cum, 0),
       volume_ath_day_usd_e6 = ath.max_day,
       volume_ath_day        = ath.max_date
     FROM (SELECT unnest($1::int[]) AS project_id) ids
     LEFT JOIN LATERAL (
       SELECT SUM(amount_usd_e6) AS cum
       FROM volume_events WHERE project_id = ids.project_id
     ) t ON true
     LEFT JOIN LATERAL (
       SELECT day AS max_date, total_usd_e6 AS max_day
       FROM volume_daily vd
       WHERE vd.project_id = ids.project_id
       ORDER BY vd.total_usd_e6 DESC LIMIT 1
     ) ath ON true
     WHERE p.id = ids.project_id`,
    [projectIds],
  )
}

// ─── ALERTS ──────────────────────────────────────────────────────────────────
async function recordAlert(
  client: PoolClient,
  projectId: number | null,
  kind: string,
  severity: "info" | "warning" | "critical",
  message: string,
  details?: Record<string, unknown>,
) {
  try {
    await client.query(
      `INSERT INTO indexer_alerts (project_id, kind, severity, message, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [projectId, kind, severity, message, details ? JSON.stringify(details) : null],
    )
  } catch (e) {
    // Never fail the cron because we couldn't write an alert.
    console.error("[tvl-revenue cron] recordAlert failed:", e)
  }
}
