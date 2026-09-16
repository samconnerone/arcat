// scripts/test-indexer-pipeline.mjs
// End-to-end test of the TVL indexer pipeline, bypassing the founder UI.
//
// 1. Find a real USDC-holding contract on Arc testnet (by scanning recent
//    USDC Transfer logs and picking the largest current balance).
// 2. Insert it as a verified project_contracts row for the first approved
//    project (treating that project as a test fixture).
// 3. Show the inserted state.
//
// After this, hit the cron route with the CRON_SECRET and verify a
// tvl_snapshots row appears.
//
// Usage:  node scripts/test-indexer-pipeline.mjs
// To clean up after: pass --cleanup as the first arg.

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
const TEST_LABEL = "[indexer-test-fixture]"  // marker so cleanup can find it

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const provider = new ethers.JsonRpcProvider(RPC)
const usdcContract = new ethers.Contract(
  USDC,
  ["function balanceOf(address) view returns (uint256)"],
  provider,
)
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)")

async function cleanup() {
  const r = await pool.query(
    `DELETE FROM project_contracts WHERE label = $1 RETURNING id, project_id, address, role`,
    [TEST_LABEL],
  )
  console.log(`Cleanup: removed ${r.rowCount} test fixture row(s).`)
  // For any project that has no live contracts after the delete, fully
  // reset the cached metrics so the next API read shows the truthful empty
  // state. Mirrors what the /api/project-contracts/[id] revoke endpoint does.
  await pool.query(`
    UPDATE projects p SET
      tvl_tracking_enabled    = false,
      tvl_usd_e6              = NULL,
      tvl_ath_usd_e6          = NULL,
      tvl_ath_block           = NULL,
      tvl_ath_at              = NULL,
      revenue_cum_usd_e6      = NULL,
      revenue_ath_day_usd_e6  = NULL,
      revenue_ath_day         = NULL,
      volume_cum_usd_e6       = NULL,
      volume_ath_day_usd_e6   = NULL,
      volume_ath_day          = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM project_contracts pc
      WHERE pc.project_id = p.id AND pc.verified_at IS NOT NULL AND pc.revoked_at IS NULL
    ) AND tvl_tracking_enabled = true
  `)
}

async function findUsdcHoldingContract() {
  // Scan the most recent USDC transfers to find an address that:
  //   (a) has bytecode (= is a contract, not an EOA)
  //   (b) has a meaningful non-zero USDC balance NOW
  console.log("Scanning recent USDC transfers on Arc to find a contract holder…")
  // Arc RPC caps eth_getLogs at 20k results. USDC is the native gas token so
  // it's very hot — 1500 blocks usually fits. We just need *some* recipients
  // to score, not a complete window.
  const latest = await provider.getBlockNumber()
  const fromBlock = Math.max(0, latest - 1500)
  const logs = await provider.getLogs({
    address: USDC,
    topics: [TRANSFER_TOPIC],
    fromBlock,
    toBlock: latest,
  })
  console.log(`  scanned blocks ${fromBlock}..${latest} → ${logs.length} transfers`)

  // Collect unique `to` addresses, then test which are contracts with non-zero balance.
  const candidates = new Set()
  for (const log of logs) {
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase()
    if (to === "0x0000000000000000000000000000000000000000") continue
    candidates.add(to)
  }
  console.log(`  ${candidates.size} unique recipients`)

  // Score by current balance. Only contracts (with code) qualify.
  const scored = []
  for (const addr of Array.from(candidates).slice(0, 80)) {
    try {
      const [code, bal] = await Promise.all([
        provider.getCode(addr),
        usdcContract.balanceOf(addr),
      ])
      if (code === "0x") continue           // skip EOAs
      if (bal === BigInt(0)) continue       // skip zero balances
      scored.push({ addr, balance: bal })
    } catch {}
  }
  scored.sort((a, b) => (b.balance > a.balance ? 1 : -1))
  return scored[0] ?? null
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup()
    await pool.end()
    return
  }

  // Pick a test-fixture project — first approved, live project.
  const projRes = await pool.query(
    `SELECT id, name, slug FROM projects
     WHERE approved = true AND live = true
     ORDER BY id ASC LIMIT 1`,
  )
  if (projRes.rows.length === 0) {
    console.error("No approved/live project available to attach the fixture to.")
    await pool.end()
    process.exit(1)
  }
  const project = projRes.rows[0]
  console.log(`Using project #${project.id} "${project.name}" (slug=${project.slug}) as the test fixture.`)

  const found = await findUsdcHoldingContract()
  if (!found) {
    console.error("Couldn't find a contract holding USDC in the last 4k blocks.")
    console.error("Indexer code paths still verified via the no_work response earlier.")
    await pool.end()
    process.exit(2)
  }
  console.log(`Found USDC-holding contract: ${found.addr}`)
  console.log(`  current USDC balance (raw): ${found.balance.toString()}`)
  console.log(`  in USDC: $${(Number(found.balance) / 1e6).toLocaleString()}`)

  // Confirm its on-chain deployer for the audit fields. We don't enforce
  // a session check here — this is a test fixture, not a real founder flow.
  const arcscanRes = await fetch(
    `https://testnet.arcscan.app/api/v2/addresses/${found.addr}`,
    { headers: { Accept: "application/json" } },
  ).catch(() => null)
  let deployer = null
  if (arcscanRes?.ok) {
    const d = await arcscanRes.json()
    deployer = d?.creator_address_hash?.toLowerCase() ?? null
  }
  console.log(`  on-chain deployer: ${deployer ?? "(unknown)"}`)

  const startBlock = await provider.getBlockNumber()
  // Insert as a TVL role with the marker label so cleanup finds it.
  await pool.query(
    `INSERT INTO project_contracts
       (project_id, address, role, label, start_block,
        deployer_address, signed_message, deployer_sig, verified_at)
     VALUES ($1, $2, 'tvl', $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (project_id, address, role) DO UPDATE SET
       label       = EXCLUDED.label,
       start_block = EXCLUDED.start_block,
       verified_at = NOW(),
       revoked_at  = NULL`,
    [
      project.id, found.addr, TEST_LABEL, startBlock,
      deployer, "test-fixture", "test-fixture",
    ],
  )
  await pool.query(
    `UPDATE projects SET tvl_tracking_enabled = true WHERE id = $1`,
    [project.id],
  )

  // Show what's now in the DB.
  const row = await pool.query(
    `SELECT id, project_id, address, role, label, start_block,
            verified_at, revoked_at
     FROM project_contracts WHERE label = $1`,
    [TEST_LABEL],
  )
  console.log("\n=== inserted project_contracts ===")
  for (const r of row.rows) console.log(r)

  const proj2 = await pool.query(
    `SELECT id, slug, tvl_tracking_enabled, tvl_usd_e6, tvl_ath_usd_e6, tvl_last_indexed_at
     FROM projects WHERE id = $1`,
    [project.id],
  )
  console.log("\n=== project row state ===")
  for (const r of proj2.rows) console.log(r)

  console.log(`\nFixture project: id=${project.id} slug=${project.slug}`)
  console.log(`Now hit:  curl http://localhost:3000/api/cron/tvl-revenue \\`)
  console.log(`            -H "Authorization: Bearer $CRON_SECRET"`)
  console.log(`Then re-query projects + tvl_snapshots to see the result.`)
  console.log(`To remove the fixture afterwards:`)
  console.log(`  node scripts/test-indexer-pipeline.mjs --cleanup`)

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
