import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const v = await pool.query(`SELECT COUNT(*)::int AS n, SUM(amount_usd_e6)::text AS sum FROM volume_events WHERE contract_id IN (SELECT id FROM project_contracts WHERE label = '[volume-test-fixture]')`)
console.log("volume_events count:", v.rows[0].n)
console.log("volume_events sum (raw e6):", v.rows[0].sum)

const p = await pool.query(`SELECT id, slug, volume_cum_usd_e6::text AS vol, volume_ath_day_usd_e6::text AS ath, volume_ath_day FROM projects WHERE volume_cum_usd_e6 IS NOT NULL`)
console.log("\n=== projects with volume ===")
for (const r of p.rows) {
  const vol = r.vol ? Number(BigInt(r.vol))/1e6 : null
  const ath = r.ath ? Number(BigInt(r.ath))/1e6 : null
  console.log(`  #${r.id} ${r.slug}  cum=$${vol?.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}  ATH-day=$${ath?.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} on ${r.volume_ath_day}`)
}

const c = await pool.query(`SELECT kind, stablecoin_id, last_block::text, updated_at FROM indexer_cursors ORDER BY kind`)
console.log("\n=== indexer cursors ===")
for (const r of c.rows) console.log(`  ${r.kind}/sc${r.stablecoin_id}  last_block=${r.last_block}  ${r.updated_at}`)

const recent = await pool.query(`SELECT tx_hash, log_index, block_number, amount_raw::text AS raw, amount_usd_e6::text AS usd FROM volume_events ORDER BY id DESC LIMIT 3`)
console.log("\n=== latest 3 volume_events ===")
for (const r of recent.rows) {
  const usd = Number(BigInt(r.usd))/1e6
  const raw = Number(BigInt(r.raw))/1e6  // USDC has 6 decimals
  console.log(`  block ${r.block_number}  log#${r.log_index}  ${raw.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} USDC → $${usd.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`)
  console.log(`    tx: ${r.tx_hash}`)
}

await pool.end()
