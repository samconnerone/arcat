// scripts/migrate-disputes.mjs
// Public-dispute table. Idempotent.
//
// Run:  node scripts/migrate-disputes.mjs

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const SQL = `
CREATE TABLE IF NOT EXISTS disputes (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric          TEXT NOT NULL CHECK (metric IN ('tvl','revenue','volume')),
  reason          TEXT NOT NULL,
  evidence_url    TEXT,
  reporter_email  TEXT,
  reporter_ip_hash TEXT,                              -- SHA-256 of IP, for abuse triage
  status          TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  admin_notes     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,                               -- admin wallet or username
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disputes_open ON disputes (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_disputes_proj_status ON disputes (project_id, status);
`

async function main() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(SQL)
    await client.query("COMMIT")
    console.log("Disputes migration committed.")

    const c = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='disputes' ORDER BY ordinal_position`,
    )
    console.log("Columns:")
    for (const r of c.rows) console.log("  ✓", r.column_name)
  } catch (e) {
    await client.query("ROLLBACK")
    console.error("Migration failed:", e)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}
main()
