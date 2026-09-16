// scripts/demo.mjs
// Single-command demo. Sets up a test fixture, triggers the indexer,
// and prints exactly what to open in your browser.
//
// Run:    node scripts/demo.mjs
// Clean:  node scripts/demo.mjs --cleanup
//
// Requires the dev server to be running on http://localhost:3000.

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
const LABEL = "[demo-fixture]"
const CRON_SECRET = process.env.CRON_SECRET
const BASE = "http://localhost:3000"

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function cleanup() {
  const r = await pool.query(
    `DELETE FROM project_contracts WHERE label = $1 RETURNING id`,
    [LABEL],
  )
  console.log(`✓ removed ${r.rowCount} fixture row(s)`)
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
  await pool.query(`DELETE FROM disputes WHERE reason ILIKE '%demo%'`)
  console.log("✓ cleaned cached metrics + demo disputes")
}

async function findUsdcHolder() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], provider)
  const latest = await provider.getBlockNumber()
  // Sample recent USDC transfers, pick the highest-balance contract recipient.
  const logs = await provider.getLogs({
    address: USDC,
    topics: [ethers.id("Transfer(address,address,uint256)")],
    fromBlock: latest - 1500, toBlock: latest,
  })
  const candidates = new Set()
  for (const log of logs) {
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase()
    if (to !== "0x0000000000000000000000000000000000000000") candidates.add(to)
  }
  let best = { addr: null, balance: BigInt(0) }
  for (const addr of Array.from(candidates).slice(0, 60)) {
    try {
      const [code, bal] = await Promise.all([provider.getCode(addr), usdc.balanceOf(addr)])
      if (code === "0x") continue
      if (bal > best.balance) best = { addr, balance: bal }
    } catch {}
  }
  return best
}

async function setup() {
  console.log("┌─ Arcat TVL/Volume/Revenue demo ─────────────────────────")
  console.log("│  Setting up a synthetic fixture on the first listed project.")
  console.log("│  This bypasses the founder UI (which needs a real wallet).")
  console.log("└───────────────────────────────────────────────────────────\n")

  // Pick fixture project — first approved/live.
  const proj = await pool.query(
    `SELECT id, name, slug FROM projects
     WHERE approved = true AND live = true ORDER BY id ASC LIMIT 1`,
  )
  if (proj.rows.length === 0) {
    throw new Error("No approved/live project to attach fixture to.")
  }
  const p = proj.rows[0]
  console.log(`Project: #${p.id} ${p.name} (slug: ${p.slug})`)

  // Find a real USDC-holding contract on Arc and attach as TVL.
  process.stdout.write("Scanning Arc for a USDC-holding contract... ")
  const found = await findUsdcHolder()
  if (!found.addr) throw new Error("No USDC-holding contract found in last 1500 blocks.")
  const usd = Number(found.balance) / 1e6
  console.log(`found ${found.addr.slice(0,10)}…${found.addr.slice(-6)} ($${usd.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})})`)

  const provider = new ethers.JsonRpcProvider(RPC)
  const startBlock = await provider.getBlockNumber()
  await pool.query(
    `INSERT INTO project_contracts
       (project_id, address, role, label, start_block,
        deployer_address, signed_message, deployer_sig, verified_at)
     VALUES ($1, $2, 'tvl', $3, $4, NULL, 'demo-fixture', 'demo-fixture', NOW())
     ON CONFLICT (project_id, address, role) DO UPDATE SET
       label = EXCLUDED.label, start_block = EXCLUDED.start_block,
       verified_at = NOW(), revoked_at = NULL`,
    [p.id, found.addr, LABEL, startBlock],
  )
  await pool.query(`UPDATE projects SET tvl_tracking_enabled = true WHERE id = $1`, [p.id])
  console.log("✓ TVL contract attached\n")

  // Trigger the indexer once so the first snapshot lands immediately.
  process.stdout.write("Triggering indexer cron... ")
  const r = await fetch(`${BASE}/api/cron/tvl-revenue`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  const data = await r.json()
  if (!data.ok) throw new Error(`Cron failed: ${JSON.stringify(data)}`)
  console.log(`✓ snapshot written (block ${data.targetBlock})\n`)

  // Output the walkthrough.
  const slug = p.slug
  console.log("═══════════════════════════════════════════════════════════════")
  console.log("  Open these in your browser — what to see at each:")
  console.log("═══════════════════════════════════════════════════════════════\n")

  console.log(`▶  http://localhost:3000/ecosystem`)
  console.log(`   • New 'TVL' and 'Volume' sort tabs near the top`)
  console.log(`   • Click 'TVL' → only ${p.name} shows`)
  console.log(`   • Card shows a blue stat row with 'TVL $${(usd/1e6).toFixed(2)}M'`)
  console.log()

  console.log(`▶  http://localhost:3000/ecosystem/${slug}`)
  console.log(`   • New 'Total Value Locked' card below the description`)
  console.log(`   • Shows the current TVL, ATH info, sparkline, '✓ verified on-chain'`)
  console.log(`   • Click 'Per-contract breakdown' → expands audit table with the`)
  console.log(`     contract address, raw USDC balance, USD value, block number`)
  console.log(`   • Click 'Flag a problem' → opens dispute form (try filing a test flag)`)
  console.log()

  console.log(`▶  http://localhost:3000/admin   (password: 123456)`)
  console.log(`   • Sign in, click 'Trust' tab in the sidebar`)
  console.log(`   • You'll see any open indexer_alerts + open disputes`)
  console.log(`   • If you filed a test dispute above, it appears here`)
  console.log(`   • Resolve/Dismiss buttons work — try them`)
  console.log()

  console.log(`▶  http://localhost:3000/api/tvl`)
  console.log(`   • Public DeFiLlama-shape JSON listing this project`)
  console.log(`   • Includes a 'methodology' block explaining how the number was computed`)
  console.log()

  console.log(`▶  http://localhost:3000/api/tvl/${slug}`)
  console.log(`   • Full detail JSON with tvl_history series + tracked_contracts`)
  console.log()

  console.log(`▶  http://localhost:3000/api/tvl/${slug}/events.csv`)
  console.log(`   • CSV download. Currently has header only (no revenue/volume contracts)`)
  console.log()

  console.log(`▶  http://localhost:3000/dashboard/${slug}`)
  console.log(`   • (Founder-only — would 401 without that project's owner wallet)`)
  console.log(`   • The 'TVL Tracking' tab is where founders register contracts`)
  console.log()

  console.log("═══════════════════════════════════════════════════════════════")
  console.log("  When you're done:  node scripts/demo.mjs --cleanup")
  console.log("═══════════════════════════════════════════════════════════════")
}

async function main() {
  if (!CRON_SECRET) {
    console.error("CRON_SECRET missing from .env.local")
    process.exit(1)
  }
  try {
    if (process.argv.includes("--cleanup")) {
      await cleanup()
    } else {
      await setup()
    }
  } catch (e) {
    console.error("Demo failed:", e?.message || e)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
