// scripts/verify-indexer-result.mjs
// Quick sanity check after running the indexer: shows the materialized
// columns on projects + the latest snapshot for the test fixture project.

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

try {
  const p = await pool.query(
    `SELECT id, slug, tvl_tracking_enabled,
            tvl_usd_e6::text   AS tvl,
            tvl_ath_usd_e6::text AS ath,
            tvl_ath_block, tvl_ath_at,
            tvl_last_indexed_at
     FROM projects WHERE tvl_tracking_enabled = true`,
  )
  console.log("=== projects with TVL tracking ===")
  for (const r of p.rows) {
    const usd = r.tvl ? (Number(BigInt(r.tvl)) / 1e6) : null
    const ath = r.ath ? (Number(BigInt(r.ath)) / 1e6) : null
    console.log(`  #${r.id} ${r.slug}`)
    console.log(`     tvl_usd      = $${usd != null ? usd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : "null"}`)
    console.log(`     tvl_ath      = $${ath != null ? ath.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : "null"}`)
    console.log(`     ath_block    = ${r.tvl_ath_block}`)
    console.log(`     ath_at       = ${r.tvl_ath_at}`)
    console.log(`     last_indexed = ${r.tvl_last_indexed_at}`)
  }

  const s = await pool.query(
    `SELECT id, project_id, block_number, block_time,
            total_usd_e6::text AS total,
            jsonb_pretty(breakdown) AS breakdown
     FROM tvl_snapshots ORDER BY id DESC LIMIT 5`,
  )
  console.log("\n=== latest tvl_snapshots ===")
  for (const r of s.rows) {
    const usd = Number(BigInt(r.total)) / 1e6
    console.log(`  snapshot #${r.id} project=${r.project_id} block=${r.block_number} at=${r.block_time}`)
    console.log(`    total = $${usd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`)
    console.log(`    breakdown: ${r.breakdown}`)
  }

  const c = await pool.query(
    `SELECT kind, stablecoin_id, last_block::text, updated_at
     FROM indexer_cursors`,
  )
  console.log("\n=== indexer cursors ===")
  for (const r of c.rows) console.log(`  ${r.kind}/sc${r.stablecoin_id}  last_block=${r.last_block}  ${r.updated_at}`)

  const a = await pool.query(`SELECT * FROM indexer_alerts ORDER BY id DESC LIMIT 5`)
  console.log(`\n=== indexer_alerts (latest 5) ===  ${a.rowCount} row(s)`)
  for (const r of a.rows) console.log(r)
} finally {
  await pool.end()
}
