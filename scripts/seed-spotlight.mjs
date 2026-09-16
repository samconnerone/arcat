// Seed the launch Spotlight items so the banner is live + meaningful on ship.
// All are real DB rows — removable anytime from Admin → Spotlight. Idempotent
// (re-running replaces the launch-seeded set). Run AFTER deploy. node scripts/seed-spotlight.mjs
import pg from "pg"
import { readFileSync } from "fs"
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// Ensure the table exists (matches the API schema) so this can run independently.
await pool.query(`CREATE TABLE IF NOT EXISTS spotlight_items (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'custom', title TEXT NOT NULL,
  subtitle TEXT, image_url TEXT, link_url TEXT, cta_text TEXT, accent TEXT, project_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending', priority INT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, created_by TEXT, image_pos TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
await pool.query(`ALTER TABLE spotlight_items ADD COLUMN IF NOT EXISTS image_pos TEXT`)

const lunex = (await pool.query(`SELECT id FROM projects WHERE slug='lunex' AND approved AND live LIMIT 1`)).rows[0]
const tower = (await pool.query(`SELECT id FROM projects WHERE name ILIKE 'Tower Exchange' AND approved AND live LIMIT 1`)).rows[0]
const towerCamp = (await pool.query(
  `SELECT slug FROM campaigns WHERE project_name ILIKE 'Tower%' AND status NOT IN ('draft','rejected','ended','cancelled') ORDER BY created_at DESC LIMIT 1`
).catch(() => ({ rows: [] }))).rows[0]

const items = [
  // editorial welcome — always-on-brand, easily removable
  { kind: "custom", title: "Discover what's building on Arc", subtitle: "Every project, every builder — verified on-chain, in one place.", link_url: "/ecosystem", cta_text: "Explore the ecosystem", accent: "#3b6bff", project_id: null, priority: 0 },
]
if (lunex) items.push({ kind: "project", title: "Lunex — a proven DeFi hub on Arc", subtitle: "Established on-chain track record · Curve-style StableSwap for USDC/EURC.", link_url: "/ecosystem/lunex", cta_text: "View project", accent: "#00b87a", project_id: lunex.id, priority: 2 })
if (towerCamp) items.push({ kind: "campaign", title: "Tower Beta Testnet is live", subtitle: "Get early access to Arc's first stablecoin DEX aggregator.", link_url: `/trials/${towerCamp.slug}`, cta_text: "Join the beta", accent: "#3b6bff", project_id: tower?.id ?? null, priority: 1 })

await pool.query(`DELETE FROM spotlight_items WHERE created_by = 'launch-seed'`)
for (const it of items) {
  await pool.query(
    `INSERT INTO spotlight_items (kind, title, subtitle, link_url, cta_text, accent, project_id, status, priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,'launch-seed')`,
    [it.kind, it.title, it.subtitle, it.link_url, it.cta_text, it.accent, it.project_id, it.priority],
  )
  console.log(`  + ${it.kind}: ${it.title}`)
}
console.log(`\nSeeded ${items.length} active spotlight item(s). Remove/curate any from Admin → Spotlight.`)
await pool.end()
