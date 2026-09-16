// scripts/backfill-attestations.mjs
// One-time: attest EVERY live project on-chain at its current trust tier.
// Subject = proven (registered) contract if it has one, else a deterministic
// project-id address derived from the slug. Reads keys from .env.local.
//
//   node scripts/backfill-attestations.mjs

import dotenv from "dotenv"
import pg from "pg"
import { createWalletClient, createPublicClient, http, keccak256, toBytes } from "viem"
import { privateKeyToAccount } from "viem/accounts"

dotenv.config({ path: ".env.local" })

const RPC = process.env.ARC_RPC_HTTP || "https://rpc.testnet.arc.network"
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002)
const REGISTRY = process.env.ARCAT_REGISTRY
const PK = process.env.ATTESTER_PRIVATE_KEY
if (!REGISTRY || !PK) { console.error("✗ Need ARCAT_REGISTRY + ATTESTER_PRIVATE_KEY in .env.local"); process.exit(1) }

const ABI = [
  { type: "function", name: "attest", stateMutability: "nonpayable", inputs: [{ name: "subject", type: "address" }, { name: "tier", type: "uint8" }, { name: "ref", type: "string" }], outputs: [] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "subject", type: "address" }], outputs: [] },
]
const TIER = { listed: 1, claimed: 2, vetted: 3, verified: 4, arc_partner: 5, arc_official: 6 }
const subjectFor = (proven, slug) =>
  proven && /^0x[a-fA-F0-9]{40}$/.test(proven) ? proven.toLowerCase()
  : ("0x" + keccak256(toBytes("arcat:project:" + slug)).slice(-40)).toLowerCase()
const tierOf = (rec, lvl) => TIER[rec === "official" ? "arc_official" : rec === "partner" ? "arc_partner" : (lvl || "listed")] ?? 1

const chain = { id: CHAIN_ID, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const account = privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK)
const wallet = createWalletClient({ account, chain, transport: http(RPC) })
const pub = createPublicClient({ chain, transport: http(RPC) })

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const rows = (await pool.query(
  `SELECT id, slug, trust_level, recognition, trust_profile, established,
          (SELECT address FROM project_contracts WHERE project_id = projects.id AND verified_at IS NOT NULL AND revoked_at IS NULL LIMIT 1) AS proven
     FROM projects WHERE approved AND live ORDER BY id`
)).rows
console.log(`Attesting ${rows.length} projects from ${account.address} → registry ${REGISTRY}`)

let ok = 0, skipped = 0, failed = 0
for (const p of rows) {
  const subject = subjectFor(p.proven, p.slug)
  const tier = tierOf(p.recognition, p.trust_level)
  // Established rides in the ref as a marker (orthogonal to the tier ladder).
  const ref = "ecosystem/" + (p.slug || "") + (p.established ? "#established" : "")
  try {
    const hash = await wallet.writeContract({ address: REGISTRY, abi: ABI, functionName: "attest", args: [subject, tier, ref], chain, account })
    await pub.waitForTransactionReceipt({ hash })
    if (p.trust_profile?.hard_risk === true) {
      const rh = await wallet.writeContract({ address: REGISTRY, abi: ABI, functionName: "revoke", args: [subject], chain, account })
      await pub.waitForTransactionReceipt({ hash: rh })
    }
    ok++
    if (ok % 25 === 0) console.log(`  …${ok}/${rows.length}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${p.slug}: ${(e?.shortMessage || e?.message || e).toString().slice(0, 120)}`)
  }
}
console.log(`\nDone. attested=${ok} failed=${failed} skipped=${skipped}`)
await pool.end()
