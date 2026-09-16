import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const email = process.argv[2]
if (!email) { console.error("usage: node scripts/check-claim.mjs <email>"); process.exit(1) }

const r = await pool.query(
  `SELECT id, name, slug, email, owner_email, owner_wallet, claimed_at, approved, live,
          (claim_token IS NOT NULL) AS has_token, claim_token_expires
   FROM projects
   WHERE LOWER(email) = LOWER($1) OR LOWER(owner_email) = LOWER($1)`,
  [email],
)
console.log(`rows for ${email}: ${r.rows.length}`)
for (const p of r.rows) console.log(JSON.stringify(p))

// Also fuzzy search in case the email differs slightly
if (r.rows.length === 0) {
  const f = await pool.query(
    `SELECT id, name, slug, email, owner_wallet, approved, live FROM projects WHERE email ILIKE $1 OR name ILIKE $1 LIMIT 10`,
    [`%${email.split("@")[0]}%`],
  )
  console.log(`fuzzy matches: ${f.rows.length}`)
  for (const p of f.rows) console.log(JSON.stringify(p))
}
await pool.end()
