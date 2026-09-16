// scripts/test-volume-pipeline.mjs
// End-to-end test of the volume indexer pipeline.
//
// Uses USDC itself as a fixture "volume" contract:
//   • The Transfer event signature has indexed args (from, to) + non-indexed
//     value, exactly the shape a real Swap event takes.
//   • This exercises the indexed-vs-non-indexed parse, the topic-hash logic,
//     the AbiCoder decode, and the cursor/backfill path against real chain
//     events.
//
// USDC's transfers aren't *really* swap volume — this is a plumbing test.
// To remove the fixture: pass --cleanup.
//
// Usage:
//   node scripts/test-volume-pipeline.mjs
//   node scripts/test-volume-pipeline.mjs --cleanup

import { readFileSync } from "node:fs"
import pg from "pg"
import { ethers } from "ethers"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const RPC = "https://rpc.testnet.arc.network"
const USDC = "0x3600000000000000000000000000000000000000"
const TEST_LABEL = "[volume-test-fixture]"

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function cleanup() {
  // Delete cursors first so the next cron doesn't try to re-scan after we
  // remove the contract row.
  const c = await pool.query(
    `SELECT id FROM project_contracts WHERE label = $1`,
    [TEST_LABEL],
  )
  for (const row of c.rows) {
    await pool.query(`DELETE FROM indexer_cursors WHERE kind = $1`, [`volume_${row.id}`])
  }
  const r = await pool.query(
    `DELETE FROM project_contracts WHERE label = $1 RETURNING id, address, role`,
    [TEST_LABEL],
  )
  console.log(`Cleanup: removed ${r.rowCount} volume fixture row(s).`)
  // Wipe their volume_events + volume_daily so the project's totals reset.
  if (r.rowCount > 0) {
    const projIds = Array.from(new Set(r.rows.map(x => x.id)))
    // Actually delete by project_id (we don't know project_id here without re-fetch).
    // Safer: leave events; rollupVolumeOntoProjects will recompute.
  }
  // Recompute projects.volume_cum_usd_e6 from the now-clean events table.
  await pool.query(`
    UPDATE projects p SET
      volume_cum_usd_e6 = COALESCE(t.cum, 0),
      volume_ath_day_usd_e6 = NULL,
      volume_ath_day = NULL
    FROM (
      SELECT project_id, SUM(amount_usd_e6) AS cum
      FROM volume_events
      WHERE EXISTS (SELECT 1 FROM project_contracts pc WHERE pc.id = volume_events.contract_id)
      GROUP BY project_id
    ) t
    WHERE p.id = t.project_id`)
  // Also nuke volume_events tied to non-existent contracts (FK cascade should
  // have done this but double-check).
  await pool.query(`DELETE FROM volume_events WHERE NOT EXISTS (
    SELECT 1 FROM project_contracts pc WHERE pc.id = volume_events.contract_id)`)
  await pool.query(`DELETE FROM volume_daily WHERE NOT EXISTS (
    SELECT 1 FROM project_contracts pc
    JOIN volume_events ve ON ve.contract_id = pc.id
    WHERE ve.project_id = volume_daily.project_id)`)
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup()
    await pool.end()
    return
  }

  // Use project #1 again — same fixture project as the TVL test.
  const projRes = await pool.query(
    `SELECT id, name, slug, tvl_tracking_enabled FROM projects
     WHERE approved = true AND live = true ORDER BY id ASC LIMIT 1`,
  )
  if (projRes.rows.length === 0) {
    console.error("No approved/live project available.")
    await pool.end()
    process.exit(1)
  }
  const project = projRes.rows[0]
  console.log(`Fixture project: #${project.id} "${project.name}" (slug=${project.slug})`)

  // Find USDC's stablecoin row id.
  const sRes = await pool.query(
    `SELECT id, symbol, decimals, peg_currency FROM stablecoins WHERE address = $1 LIMIT 1`,
    [USDC],
  )
  if (sRes.rows.length === 0) {
    console.error("USDC not in stablecoins registry — run seed-stablecoins.mjs first.")
    await pool.end()
    process.exit(1)
  }
  const stable = sRes.rows[0]
  console.log(`Stablecoin: ${stable.symbol} #${stable.id}`)

  // Pick a small recent window so the test runs fast.
  const provider = new ethers.JsonRpcProvider(RPC)
  const head = await provider.getBlockNumber()
  const startBlock = head - 200  // ≈200 blocks of recent volume

  const eventSignature = "Transfer(address indexed from, address indexed to, uint256 value)"
  // canonical = Transfer(address,address,uint256) → topic
  // dataArgs  = ["uint256"] → amount_arg=0
  const topic = ethers.id("Transfer(address,address,uint256)")
  console.log(`Event signature:  ${eventSignature}`)
  console.log(`Topic (computed): ${topic}`)

  // Insert as a verified volume contract for the fixture project. We bypass
  // the API (which requires a session) since this is a backend test.
  const res = await pool.query(
    `INSERT INTO project_contracts
       (project_id, address, role, label, start_block,
        deployer_address, signed_message, deployer_sig, verified_at,
        volume_event_signature, volume_event_topic, volume_amount_arg, volume_stablecoin_id)
     VALUES ($1, $2, 'volume', $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11)
     ON CONFLICT (project_id, address, role) DO UPDATE SET
       label                  = EXCLUDED.label,
       start_block            = EXCLUDED.start_block,
       verified_at            = NOW(),
       revoked_at             = NULL,
       volume_event_signature = EXCLUDED.volume_event_signature,
       volume_event_topic     = EXCLUDED.volume_event_topic,
       volume_amount_arg      = EXCLUDED.volume_amount_arg,
       volume_stablecoin_id   = EXCLUDED.volume_stablecoin_id
     RETURNING id`,
    [
      project.id, USDC, TEST_LABEL, startBlock,
      null, "volume-test-fixture", "volume-test-fixture",
      eventSignature, topic, 0, stable.id,
    ],
  )
  const contractId = res.rows[0].id
  console.log(`Inserted volume contract row #${contractId}`)
  console.log(`Start block: ${startBlock}, current head: ${head}`)
  console.log(``)
  console.log(`Trigger the indexer to populate volume_events:`)
  console.log(`  curl http://localhost:3000/api/cron/tvl-revenue \\`)
  console.log(`    -H "Authorization: Bearer $CRON_SECRET"`)
  console.log(``)
  console.log(`Then re-read project + volume_events with verify-indexer-result.mjs`)
  console.log(``)
  console.log(`To remove the fixture afterwards:`)
  console.log(`  node scripts/test-volume-pipeline.mjs --cleanup`)

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
