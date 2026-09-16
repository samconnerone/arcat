// scripts/migrate-tvl.mjs
// Schema for TVL & revenue tracking. Idempotent — safe to run multiple times.
//
// Run:  node scripts/migrate-tvl.mjs
//
// Tables:
//   stablecoins         — curated registry of tracked stable assets (address, decimals, peg)
//   project_contracts   — founder-declared (project, address, role) with deployer signature
//   indexer_cursors     — per-stablecoin block cursor so the cron resumes where it left off
//   tvl_snapshots       — one row per block where a tracked balance changed
//   revenue_events      — every fee inflow into a revenue contract
//   revenue_daily       — daily rollup so charts stay fast at any history depth
//   forex_rates         — daily non-USD pegs (EUR, BRL, etc.) for cross-currency conversion
//   indexer_alerts      — drift checks, gap detection, anything the operator must see
//
// Also adds ATH columns on `projects`.

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
-- ─── STABLECOIN REGISTRY ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stablecoins (
  id              SERIAL PRIMARY KEY,
  address         TEXT UNIQUE NOT NULL,           -- lowercase
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  decimals        SMALLINT NOT NULL,
  peg_currency    TEXT NOT NULL DEFAULT 'USD',    -- 'USD', 'EUR', 'BRL', ...
  active          BOOLEAN NOT NULL DEFAULT true,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_stablecoins_active ON stablecoins (active) WHERE active;

-- ─── FOREX RATES ─────────────────────────────────────────────────────────────
-- One row per (currency, effective_date). USD is always present with rate 1.0.
-- Non-USD pegs are refreshed daily from a single transparent source.
CREATE TABLE IF NOT EXISTS forex_rates (
  currency        TEXT NOT NULL,                  -- 'USD', 'EUR', 'BRL', ...
  effective_date  DATE NOT NULL,
  rate_to_usd     NUMERIC(18,8) NOT NULL,         -- 1 unit of currency = N USD
  source          TEXT NOT NULL,                  -- 'hardcoded', 'ecb', 'chainlink', ...
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (currency, effective_date)
);

-- Seed the hardcoded USD = 1 row for today; safe to re-run.
INSERT INTO forex_rates (currency, effective_date, rate_to_usd, source)
VALUES ('USD', CURRENT_DATE, 1.0, 'hardcoded')
ON CONFLICT DO NOTHING;

-- ─── PROJECT CONTRACTS (FOUNDER-DECLARED) ────────────────────────────────────
-- Founder declares which contracts hold TVL or collect revenue.
-- Goes live only after deployer_sig is set (signature from contract's deployer).
CREATE TABLE IF NOT EXISTS project_contracts (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  address             TEXT NOT NULL,              -- lowercase
  role                TEXT NOT NULL CHECK (role IN ('tvl', 'revenue', 'treasury')),
  label               TEXT,                       -- founder-supplied display name
  start_block         BIGINT NOT NULL,
  deployer_address    TEXT,                       -- read from chain at submit time
  deployer_sig        TEXT,                       -- EIP-191 signature; NULL = pending
  signed_message      TEXT,                       -- exact message that was signed
  verified_at         TIMESTAMPTZ,                -- set when sig validates
  revoked_at          TIMESTAMPTZ,                -- admin can revoke without delete
  revoke_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, address, role)
);
CREATE INDEX IF NOT EXISTS idx_pc_address    ON project_contracts (address);
CREATE INDEX IF NOT EXISTS idx_pc_live       ON project_contracts (project_id)
  WHERE verified_at IS NOT NULL AND revoked_at IS NULL;

-- ─── INDEXER CURSORS ─────────────────────────────────────────────────────────
-- One row per (kind, stablecoin_id). Cron reads + advances atomically.
CREATE TABLE IF NOT EXISTS indexer_cursors (
  kind            TEXT NOT NULL,                  -- 'tvl_revenue', 'drift', ...
  stablecoin_id   INTEGER REFERENCES stablecoins(id) ON DELETE CASCADE,
  last_block      BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, stablecoin_id)
);

-- ─── TVL SNAPSHOTS ───────────────────────────────────────────────────────────
-- One row per project per block where a tracked balance changed.
-- total_usd_e6 stores USD-denominated total in 6-decimal fixed-point (matches USDC scale).
-- breakdown JSONB holds [{contract, stablecoin, balance_raw}, ...] for audit.
CREATE TABLE IF NOT EXISTS tvl_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  block_number    BIGINT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL,
  total_usd_e6    NUMERIC(38,0) NOT NULL,         -- e.g. $12.4M => 12400000_000000
  breakdown       JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tvl_proj_block ON tvl_snapshots (project_id, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_tvl_proj_time  ON tvl_snapshots (project_id, block_time DESC);

-- ─── REVENUE EVENTS ──────────────────────────────────────────────────────────
-- Every USDC/EURC/etc Transfer INTO a 'revenue' contract is a fee inflow.
-- One row per log; tx_hash + log_index = unique.
CREATE TABLE IF NOT EXISTS revenue_events (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_id     INTEGER NOT NULL REFERENCES project_contracts(id) ON DELETE CASCADE,
  stablecoin_id   INTEGER NOT NULL REFERENCES stablecoins(id),
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL,
  from_address    TEXT NOT NULL,
  amount_raw      NUMERIC(38,0) NOT NULL,         -- in stablecoin's native decimals
  amount_usd_e6   NUMERIC(38,0) NOT NULL,         -- converted to USD at block-day FX
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_rev_proj_time  ON revenue_events (project_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_rev_proj_block ON revenue_events (project_id, block_number DESC);

-- ─── REVENUE DAILY ROLLUP ────────────────────────────────────────────────────
-- Materialized daily totals — kept in sync by the indexer. Powers fast charts.
CREATE TABLE IF NOT EXISTS revenue_daily (
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  total_usd_e6    NUMERIC(38,0) NOT NULL,
  event_count     INTEGER NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS idx_revd_proj_day ON revenue_daily (project_id, day DESC);

-- ─── INDEXER ALERTS ──────────────────────────────────────────────────────────
-- Surface drift / gaps / RPC failures to admin in public so we never silently miscount.
CREATE TABLE IF NOT EXISTS indexer_alerts (
  id              BIGSERIAL PRIMARY KEY,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                  -- 'drift', 'gap', 'rpc_error', ...
  severity        TEXT NOT NULL DEFAULT 'warning',-- 'info' | 'warning' | 'critical'
  message         TEXT NOT NULL,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON indexer_alerts (created_at DESC)
  WHERE resolved_at IS NULL;

-- ─── PROJECTS: CACHED TVL / REVENUE / ATH COLUMNS ────────────────────────────
-- Materialized onto the row so the ecosystem grid stays one-query fast.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_usd_e6              NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_ath_usd_e6          NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_ath_block           BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_ath_at              TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revenue_cum_usd_e6      NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revenue_ath_day_usd_e6  NUMERIC(38,0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revenue_ath_day         DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_last_indexed_at     TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tvl_tracking_enabled    BOOLEAN NOT NULL DEFAULT false;
`

async function main() {
  console.log("Connecting to DB...")
  const client = await pool.connect()
  try {
    console.log("Running migration...")
    await client.query("BEGIN")
    await client.query(SQL)
    await client.query("COMMIT")
    console.log("Migration committed.")

    // Verify the tables landed
    const r = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN (
          'stablecoins','project_contracts','indexer_cursors',
          'tvl_snapshots','revenue_events','revenue_daily',
          'forex_rates','indexer_alerts'
        )
      ORDER BY table_name
    `)
    console.log("\nTables present:")
    for (const row of r.rows) console.log("  ✓", row.table_name)

    const c = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='projects'
        AND column_name IN (
          'tvl_usd_e6','tvl_ath_usd_e6','tvl_ath_block','tvl_ath_at',
          'revenue_cum_usd_e6','revenue_ath_day_usd_e6','revenue_ath_day',
          'tvl_last_indexed_at','tvl_tracking_enabled'
        )
      ORDER BY column_name
    `)
    console.log("\nNew columns on projects:")
    for (const row of c.rows) console.log("  ✓", row.column_name)
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
