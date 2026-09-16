import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// Campaigns with the most completions, and how many are rated vs unrated.
const r = await pool.query(`
  SELECT c.id, c.title,
         COUNT(cc.*)                                        AS total,
         COUNT(cc.*) FILTER (WHERE cc.builder_rating IS NOT NULL) AS rated,
         COUNT(cc.*) FILTER (WHERE cc.builder_rating IS NULL)     AS unrated,
         COUNT(cc.*) FILTER (WHERE cc.status = 'reviewed')        AS reviewed
  FROM campaigns c
  JOIN campaign_completions cc ON cc.campaign_id = c.id
  GROUP BY c.id, c.title
  ORDER BY total DESC
  LIMIT 8
`)
console.log("campaign_id | title | total | rated | unrated | reviewed")
for (const x of r.rows) console.log(`${x.id} | ${x.title} | total=${x.total} rated=${x.rated} unrated=${x.unrated} reviewed=${x.reviewed}`)

// Sanity: a sample rated row — confirm the fields the UI/filter read exist.
const s = await pool.query(`
  SELECT campaign_id, builder_rating, status, xp_earned, quality_score
  FROM campaign_completions
  WHERE builder_rating IS NOT NULL
  LIMIT 3
`)
console.log("\nsample rated rows:")
for (const x of s.rows) console.log(JSON.stringify(x))
await pool.end()
