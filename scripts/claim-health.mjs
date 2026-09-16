import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// 1. Totals
const totals = await pool.query(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE approved AND live)::int approved_live,
    COUNT(*) FILTER (WHERE owner_wallet IS NOT NULL)::int claimed,
    COUNT(*) FILTER (WHERE owner_wallet IS NOT NULL AND approved AND live)::int claimed_live
  FROM projects`)
console.log("=== TOTALS ===")
console.log(JSON.stringify(totals.rows[0]))

// 2. Malformed owner_wallets — would break the gate for that project
const bad = await pool.query(`
  SELECT id, name, slug, owner_wallet
  FROM projects
  WHERE owner_wallet IS NOT NULL
    AND (owner_wallet !~ '^0x[0-9a-f]{40}$')`)
console.log(`\n=== MALFORMED owner_wallet (not lowercase 0x+40hex): ${bad.rows.length} ===`)
for (const r of bad.rows) console.log(`  id ${r.id} ${r.slug}: [${r.owner_wallet}]`)

// 3. Claimed but NOT approved/live — gate requires approved AND live, so these
//    owners are locked out even with the right wallet. Systemic-ish trap.
const lockedByFlags = await pool.query(`
  SELECT id, name, slug, approved, live, owner_wallet
  FROM projects
  WHERE owner_wallet IS NOT NULL AND NOT (approved AND live)`)
console.log(`\n=== CLAIMED but NOT (approved AND live) — would be locked out: ${lockedByFlags.rows.length} ===`)
for (const r of lockedByFlags.rows) console.log(`  id ${r.id} ${r.slug}: approved=${r.approved} live=${r.live}`)

// 4. Per claimed project: is owner_wallet a known Circle wallet or browser wallet,
//    and does the Circle wallet for its email MATCH the owner_wallet?
const claimed = await pool.query(`
  SELECT p.id, p.name, p.slug, p.email, p.owner_wallet, p.claimed_at,
         (SELECT LOWER(wallet_address) FROM circle_wallet_users c WHERE LOWER(c.email)=LOWER(p.email) LIMIT 1) AS circle_for_email,
         EXISTS (SELECT 1 FROM circle_wallet_users c WHERE LOWER(c.wallet_address)=p.owner_wallet) AS owner_is_circle
  FROM projects p
  WHERE p.owner_wallet IS NOT NULL
  ORDER BY p.claimed_at DESC NULLS LAST`)
console.log(`\n=== CLAIMED PROJECTS (${claimed.rows.length}) ===`)
for (const r of claimed.rows) {
  const kind = r.owner_is_circle ? "circle" : "browser"
  const mismatch = r.circle_for_email && r.circle_for_email !== r.owner_wallet
    ? `  ⚠ circle-for-email(${r.circle_for_email}) != owner_wallet` : ""
  console.log(`  [${r.id}] ${r.slug.padEnd(16)} ${kind.padEnd(7)} owner=${r.owner_wallet}${mismatch}`)
}

await pool.end()
