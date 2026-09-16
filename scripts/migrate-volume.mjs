// scripts/migrate-volume.mjs
// Extends the TVL schema with volume tracking. Idempotent.
//
// Volume is computed *precisely* from the protocol's own Swap event,
// declared per-contract by the founder. We never approximate via
// Transfer-outflow heuristics — that's the DeFiLlama-style pattern we
// deliberately avoided. Every volume_events row has a tx_hash + log_index
// → audit-reproducible.
//
// Run:  node scripts/migrate-volume.mjs

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
-- ─── project_contracts: extend role CHECK + add volume metadata ──────────────
-- Drop the existing CHECK so we can add 'volume' to the allowed roles.
ALTER TABLE project_contracts DROP CONSTRAINT IF EXISTS project_contracts_role_check;
ALTER TABLE project_contracts
  ADD CONSTRAINT project_contracts_role_check
  CHECK (role IN ('tvl', 'revenue', 'treasury', 'volume'));

-- Per-contract volume configuration. Only populated for role='volume'.
--   volume_event_signature: human form, e.g. "Swap(address,uint256,uint256,address)"
--   volume_event_topic:     keccak256(signature) → topic[0] filter (lowercase 0x-prefixed)
--   volume_amount_arg:      0-based index into the non-indexed args (data section)
--                           that holds the trade amount in the stablecoin's decimals
--   volume_stablecoin_id:   FK → stablecoins; declares the denomination of the amount
ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS volume_event_signature TEXT;
ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS volume_event_topic     TEXT;
ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS volume_amount_arg      SMALLINT;
ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS volume_stablecoin_id   INTEGER REFERENCES stablecoins(id);

-- Sanity: if role='volume' the volume_* fields must all be set. Enforced by
-- the API layer (we don't add a partial CHECK constraint because it'd block
-- legitimate role flips from 'tvl' → 'volume' mid-edit).

-- ─── VOLUME EVENTS ───────────────────────────────────────────────────────────
-- One row per Swap event from a tracked volume contract. UNIQUE on
-- (tx_hash, log_index) makes the indexer idempotent on re-runs.
CREATE TABLE IF NOT EXISTS volume_events (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_id     INTEGER NOT NULL REFERENCES project_contracts(id) ON DELETE CASCADE,
  stablecoin_id   INTEGER NOT NULL REFERENCES stablecoins(id),
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL,
  amount_raw      NUMERIC(38,0) NOT NULL,
  amount_usd_e6   NUMERIC(38,0) NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_vol_proj_time  ON volume_events (project_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_vol_proj_block ON volume_events (project_id, block_number DESC);

-- ─── VOLUME DAILY ROLLUP ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS volume_daily (
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  total_usd_e6    NUMERIC(38,0) NOT NULL,
  event_count     INTEGER NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS idx_vold_proj_day ON volume_daily (project_id, day DESC);

-- ─── projects: materialized volume columns ───────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS volume_cum_usd_e6      NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS volume_ath_day_usd_e6  NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS volume_ath_day         DATE;
`

async function main() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(SQL)
    await client.query("COMMIT")
    console.log("Volume migration committed.")

    const t = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('volume_events','volume_daily')
      ORDER BY table_name`)
    console.log("\nNew tables:")
    for (const r of t.rows) console.log("  ✓", r.table_name)

    const cPc = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='project_contracts'
        AND column_name IN ('volume_event_signature','volume_event_topic','volume_amount_arg','volume_stablecoin_id')
      ORDER BY column_name`)
    console.log("\nproject_contracts new columns:")
    for (const r of cPc.rows) console.log("  ✓", r.column_name)

    const cP = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='projects'
        AND column_name IN ('volume_cum_usd_e6','volume_ath_day_usd_e6','volume_ath_day')
      ORDER BY column_name`)
    console.log("\nprojects new columns:")
    for (const r of cP.rows) console.log("  ✓", r.column_name)

    const chk = await client.query(`
      SELECT conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname='project_contracts' AND conname='project_contracts_role_check'`)
    console.log("\nrole CHECK:")
    for (const r of chk.rows) console.log("  ✓", r.def)
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
