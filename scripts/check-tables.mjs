import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)
console.log("=== Tables ===")
for (const r of t.rows) console.log(r.table_name)

// Find every column that looks like it stores a wallet
const c = await pool.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public'
    AND (column_name ILIKE '%wallet%' OR column_name ILIKE '%address%' OR column_name = 'deployer')
  ORDER BY table_name, column_name
`)
console.log("\n=== Wallet/address columns ===")
for (const r of c.rows) console.log(`${r.table_name}.${r.column_name}`)

// Estimate total unique wallet base (union across every wallet-bearing table)
const u = await pool.query(`
  SELECT COUNT(DISTINCT w) AS total_unique_wallets FROM (
    SELECT LOWER(owner_wallet) w FROM projects WHERE owner_wallet IS NOT NULL
    UNION
    SELECT LOWER(tester_wallet) FROM campaign_completions WHERE tester_wallet IS NOT NULL
    UNION
    SELECT LOWER(wallet) FROM reviews WHERE wallet IS NOT NULL
    UNION
    SELECT LOWER(wallet) FROM tester_reputation WHERE wallet IS NOT NULL
    UNION
    SELECT LOWER(deployer) FROM contracts WHERE deployer IS NOT NULL
    UNION
    SELECT LOWER(creator_wallet) FROM campaigns WHERE creator_wallet IS NOT NULL
  ) z
`)
console.log("\nUnion of all wallet-bearing tables:", u.rows[0].total_unique_wallets)

// Circle DCW users if table exists
try {
  const r = await pool.query("SELECT COUNT(*) FROM circle_wallet_users")
  console.log("Circle Dev Wallet users:", r.rows[0].count)
} catch { console.log("circle_wallet_users table: not present") }

// Unique reviewers
const rev = await pool.query("SELECT COUNT(DISTINCT wallet) FROM reviews WHERE wallet IS NOT NULL")
console.log("Unique reviewers:", rev.rows[0].count)

// Unique contract claimers (deployer column on contracts)
const cc = await pool.query("SELECT COUNT(DISTINCT deployer) FROM contracts WHERE deployer IS NOT NULL")
console.log("Unique contract claimers:", cc.rows[0].count)

// Sessions / auth tracking?
try {
  const s = await pool.query("SELECT COUNT(*) FROM sessions")
  console.log("sessions rows:", s.rows[0].count)
} catch { console.log("sessions table: not present (stateless cookie auth)") }

await pool.end()
