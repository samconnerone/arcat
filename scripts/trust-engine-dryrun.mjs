// scripts/trust-engine-dryrun.mjs
// Phase 1 check engine — DRY RUN. Analyzes each project's real contracts + the
// website-safety signal, and prints the level they WOULD get. Writes nothing to
// the DB or the chain. Read-only (RPC reads + explorer API + MetaMask's open
// phishing list + DB SELECTs).
//
//   node scripts/trust-engine-dryrun.mjs

import fs from "fs"
import { Pool } from "pg"
import { ethers } from "ethers"

const ARC_RPC = "https://rpc.testnet.arc.network"
const ARCSCAN = "https://testnet.arcscan.app/api/v2"
const EIP1967_IMPL  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
// MetaMask's open crypto-phishing list — the same data behind its "Deceptive
// site ahead" warning. Free, no API key. (Google Safe Browsing slots in later.)
const MM_LIST = "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json"

const POWER_FLAGS = ["mint", "blacklist", "blocklist", "freeze", "pause", "drain", "withdrawall", "sweep", "seize", "selfdestruct", "setfee"]

const env  = fs.readFileSync(".env.local", "utf8")
const url  = env.match(/^DATABASE_URL\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, "")
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })
const provider = new ethers.JsonRpcProvider(ARC_RPC, { chainId: 5042002, name: "arc-testnet" })

// ── Website safety ───────────────────────────────────────────────────────────
async function loadPhishingList() {
  try {
    const r = await fetch(MM_LIST)
    if (!r.ok) return null
    const d = await r.json()
    return { block: new Set((d.blacklist || []).map(s => s.toLowerCase())), allow: new Set((d.whitelist || []).map(s => s.toLowerCase())) }
  } catch { return null }
}
function hostOf(website) {
  if (!website) return null
  try { return new URL(website.startsWith("http") ? website : "https://" + website).hostname.toLowerCase().replace(/^www\./, "") } catch { return null }
}
function checkWebsite(host, list) {
  if (!host) return "no website"
  if (!list) return "list unavailable"
  if (list.block.has(host)) return "FLAGGED (on MetaMask scam list)"
  if (list.allow.has(host)) return "known-good"
  return "clean"
}

// ── Contract safety ──────────────────────────────────────────────────────────
async function analyzeContract(c) {
  const addr = c.address
  const out = { addr, role: c.role, deployerVerified: !!c.verified, sourceVerified: false, powers: [], upgradeable: false, adminType: "n/a", ownership: "unknown", isContract: false }
  try { const code = await provider.getCode(addr); out.isContract = !!code && code !== "0x" } catch {}
  try {
    const r = await fetch(`${ARCSCAN}/smart-contracts/${addr}`, { headers: { Accept: "application/json" } })
    if (r.ok) {
      const d = await r.json()
      out.sourceVerified = !!d.is_verified
      const abi = d.abi
      if (Array.isArray(abi)) {
        const fns = abi.filter(x => x.type === "function").map(x => (x.name || "").toLowerCase())
        out.powers = POWER_FLAGS.filter(p => fns.some(n => n.includes(p)))
      }
    }
  } catch {}
  try {
    const impl = await provider.getStorage(addr, EIP1967_IMPL)
    if (impl && BigInt(impl) !== 0n) {
      out.upgradeable = true
      const adm = await provider.getStorage(addr, EIP1967_ADMIN)
      if (adm && BigInt(adm) !== 0n) {
        const a = "0x" + adm.slice(-40)
        const code = await provider.getCode(a)
        out.adminType = code && code !== "0x" ? "contract (multisig/timelock?)" : "single EOA"
      }
    }
  } catch {}
  try {
    const ct = new ethers.Contract(addr, ["function owner() view returns (address)", "function admin() view returns (address)"], provider)
    let o = null
    try { o = await ct.owner() } catch { try { o = await ct.admin() } catch {} }
    if (o) {
      if (BigInt(o) === 0n) out.ownership = "renounced"
      else { const code = await provider.getCode(o); out.ownership = code && code !== "0x" ? "multisig/contract" : "single EOA" }
    }
  } catch {}
  return out
}

function contractSafetyVerdict(analyzed) {
  const reasons = []
  if (!analyzed.length) return { pass: false, reasons: ["no contracts registered"] }
  for (const c of analyzed) {
    if (!c.deployerVerified) reasons.push(`${c.addr.slice(0,8)}… not deployer-verified`)
    if (c.isContract && !c.sourceVerified) reasons.push(`${c.addr.slice(0,8)}… source NOT verified`)
    if (c.upgradeable && c.adminType === "single EOA") reasons.push(`${c.addr.slice(0,8)}… upgradeable by a single EOA`)
    if (c.powers.length) reasons.push(`${c.addr.slice(0,8)}… powers to review: ${c.powers.join(", ")}`)
  }
  const hardFail = analyzed.some(c => !c.deployerVerified || (c.isContract && !c.sourceVerified) || (c.upgradeable && c.adminType === "single EOA"))
  return { pass: !hardFail, reasons }
}

;(async () => {
  const phish = await loadPhishingList()
  console.log(`\nPhase 1 check engine — DRY RUN (read-only).`)
  console.log(phish ? `MetaMask phishing list: ${phish.block.size} blocked domains loaded.` : `MetaMask list unavailable (network).`)

  // ── Website-safety scan across ALL live projects ──
  const all = (await pool.query(`SELECT name, website FROM projects WHERE approved AND live AND website IS NOT NULL`)).rows
  const flagged = all.map(p => ({ name: p.name, host: hostOf(p.website), v: checkWebsite(hostOf(p.website), phish) })).filter(x => x.v.startsWith("FLAGGED"))
  console.log(`\nWebsite safety: ${all.length} sites checked · ${flagged.length} flagged.`)
  flagged.forEach(f => console.log(`   ⛔ ${f.name} — ${f.host}`))

  // ── Contract-bearing projects ──
  const rows = (await pool.query(
    `SELECT p.id, p.name, p.website,
            (p.tvl_usd_e6 IS NOT NULL AND p.tvl_usd_e6 <> '0') AS live,
            bp.identity_level
       FROM projects p
       LEFT JOIN builder_profiles bp ON bp.address = p.owner_wallet
      WHERE p.approved AND p.live
        AND EXISTS (SELECT 1 FROM project_contracts pc WHERE pc.project_id = p.id AND pc.revoked_at IS NULL)
      ORDER BY p.id`
  )).rows

  console.log(`\n${rows.length} project(s) with contracts:\n`)
  for (const p of rows) {
    const contracts = (await pool.query(
      `SELECT address, role, (verified_at IS NOT NULL) AS verified FROM project_contracts WHERE project_id = $1 AND revoked_at IS NULL`,
      [p.id]
    )).rows
    const analyzed = []
    for (const c of contracts) analyzed.push(await analyzeContract(c))
    const verdict = contractSafetyVerdict(analyzed)
    const web = checkWebsite(hostOf(p.website), phish)
    const webFlagged = web.startsWith("FLAGGED")
    const wouldBe = (verdict.pass && !webFlagged) ? (p.live ? "screened (→ verified once audited)" : "screened") : "stays identified / risk-flagged"

    console.log(`#${p.id} ${p.name}  [identity: ${p.identity_level || "none"}, live: ${p.live ? "yes" : "no"}]`)
    console.log(`   website ${hostOf(p.website) || "(none)"} → ${web}`)
    for (const c of analyzed) {
      console.log(`   ${c.role.padEnd(8)} ${c.addr}`)
      console.log(`      deployer-verified: ${c.deployerVerified} · source-verified: ${c.sourceVerified} · upgradeable: ${c.upgradeable}${c.upgradeable ? " (admin: " + c.adminType + ")" : ""} · ownership: ${c.ownership}${c.powers.length ? " · powers: " + c.powers.join(",") : ""}`)
    }
    console.log(`   → contract safety: ${verdict.pass ? "PASS" : "FAIL"}${verdict.reasons.length ? " (" + verdict.reasons.join("; ") + ")" : ""}`)
    console.log(`   → level if identity completed: ${wouldBe}\n`)
  }

  console.log("(dry run — nothing written. identity from Phase 2; Google Safe Browsing + screening add later.)")
  await pool.end()
})().catch(e => { console.error(e.message); process.exit(1) })
