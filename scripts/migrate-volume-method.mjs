// scripts/migrate-volume-method.mjs
// Adds the `volume_method` column so volume contracts can be tracked two ways:
//
//   • 'swap_event'        — precise. Decodes the founder-declared Swap event.
//                           Requires volume_event_signature + volume_amount_arg.
//   • 'outflow_transfer'  — approximate. Sums USDC Transfer events FROM the
//                           contract. Designed for aggregators (Tower, 1inch,
//                           Paraswap, Jupiter etc.) whose router contracts
//                           don't emit Swap events.
//
// Existing rows keep their behavior because the column defaults to 'swap_event'.
//
// Run:  node scripts/migrate-volume-method.mjs

import { readFileSync } from "node:fs"
import pg from "pg"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const SQL = `
ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS volume_method TEXT
  CHECK (volume_method IS NULL OR volume_method IN ('swap_event','outflow_transfer'))
  DEFAULT 'swap_event';

-- Backfill: every existing volume row was a swap_event registration.
UPDATE project_contracts SET volume_method = 'swap_event'
  WHERE role = 'volume' AND volume_method IS NULL;
`

async function main() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(SQL)
    await client.query("COMMIT")
    console.log("✓ volume_method column added + backfilled.")

    const r = await client.query(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_name='project_contracts' AND column_name='volume_method'`,
    )
    for (const row of r.rows) console.log("  ✓", row.column_name, row.data_type, row.column_default)
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
