// scripts/migrate-campaign-end.mjs
// Adds the proper "actually ended" fields to campaigns:
//   ended_at      TIMESTAMPTZ — when the campaign actually ended
//   ended_reason  TEXT        — 'slots_filled' | 'expired' | 'admin_closed'
//
// Backfills both fields for any campaign already past its end state.
// Idempotent — safe to re-run.

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const SCHEMA = `
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ended_at     TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ended_reason TEXT
  CHECK (ended_reason IS NULL OR ended_reason IN ('slots_filled','expired','admin_closed'));

CREATE INDEX IF NOT EXISTS idx_campaigns_ended_at ON campaigns (ended_at DESC) WHERE ended_at IS NOT NULL;
`

const BACKFILL_EXISTING_ENDED = `
UPDATE campaigns c SET
  ended_at = COALESCE(
    (SELECT MAX(cc.created_at) FROM campaign_completions cc WHERE cc.campaign_id = c.id),
    c.expires_at,
    NOW()
  ),
  ended_reason = CASE
    WHEN c.total_slots IS NOT NULL AND c.filled_slots >= c.total_slots THEN 'slots_filled'
    WHEN c.expires_at  IS NOT NULL AND c.expires_at < NOW()             THEN 'expired'
    ELSE 'admin_closed'
  END
WHERE c.status = 'ended' AND c.ended_at IS NULL
RETURNING c.id, c.title, c.ended_at, c.ended_reason
`

const CLOSE_SECRETLY_ENDED = `
UPDATE campaigns SET
  status = 'ended',
  ended_at = CASE
    WHEN total_slots IS NOT NULL AND filled_slots >= total_slots THEN
      COALESCE(
        (SELECT MAX(cc.created_at) FROM campaign_completions cc WHERE cc.campaign_id = campaigns.id),
        NOW()
      )
    ELSE COALESCE(expires_at, NOW())
  END,
  ended_reason = CASE
    WHEN total_slots IS NOT NULL AND filled_slots >= total_slots THEN 'slots_filled'
    ELSE 'expired'
  END
WHERE status = 'active'
  AND (
    (total_slots IS NOT NULL AND filled_slots >= total_slots)
    OR (expires_at IS NOT NULL AND expires_at < NOW())
  )
RETURNING id, title, ended_at, ended_reason
`

async function main() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(SCHEMA)

    const a = await client.query(BACKFILL_EXISTING_ENDED)
    console.log("Backfilled " + a.rowCount + " already-ended campaign(s) with new fields:")
    for (const r of a.rows) {
      console.log("  - #" + r.id + ' "' + r.title + '" → ended ' + new Date(r.ended_at).toISOString() + " (" + r.ended_reason + ")")
    }

    const b = await client.query(CLOSE_SECRETLY_ENDED)
    console.log("\nClosed " + b.rowCount + " campaign(s) that were secretly ended:")
    for (const r of b.rows) {
      console.log("  - #" + r.id + ' "' + r.title + '" → ended ' + new Date(r.ended_at).toISOString() + " (" + r.ended_reason + ")")
    }

    await client.query("COMMIT")
    console.log("\n✓ campaign-end migration committed.")
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
