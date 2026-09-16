// scripts/migrate-trust-layer.mjs
// Phase 0 of the Arcat trust layer: add the structured trust state.
//
// SAFE BY DEFAULT: running with no args is a DRY RUN — it prints the exact SQL
// and current counts and changes NOTHING. It only writes when you pass --apply.
// It is purely ADDITIVE (new columns) and leaves the existing `badge` column
// untouched, so the current UI keeps working while the new system is built
// alongside it.
//
//   node scripts/migrate-trust-layer.mjs            # dry run (preview only)
//   node scripts/migrate-trust-layer.mjs --apply    # actually run it
//
// NOTE: .env.local DATABASE_URL points at PRODUCTION, so --apply hits prod.

import fs from "fs"
import { Pool } from "pg"

const APPLY = process.argv.includes("--apply")
const env   = fs.readFileSync(".env.local", "utf8")
const url   = env.match(/^DATABASE_URL\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, "")
const pool  = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })

const STATEMENTS = [
  // ── projects: trust state (additive; old `badge` left intact) ──────────────
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS trust_level      TEXT        NOT NULL DEFAULT 'listed'`, // listed|identified|screened|verified
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS recognition      TEXT`,                                   // null|partner|official
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS trust_profile    JSONB       NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS trust_updated_at TIMESTAMPTZ`,

  // ── builder_profiles: verify-once identity (booleans mark whether the
  //    existing twitter/website/email values have actually been PROVEN) ───────
  `ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS x_verified           BOOLEAN     NOT NULL DEFAULT false`,
  `ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS domain_verified      BOOLEAN     NOT NULL DEFAULT false`,
  `ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS contact_verified     BOOLEAN     NOT NULL DEFAULT false`,
  `ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS identity_level       TEXT        NOT NULL DEFAULT 'none'`, // none|claimed|identified
  `ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ`,

  // ── project_contracts: optional, cosmetic per-contract label (e.g. "Yield
  //    Vault"). Nullable — naming is opt-in and never required. ───────────────
  `ALTER TABLE project_contracts ADD COLUMN IF NOT EXISTS label TEXT`,

  // ── Backfill projects CONSERVATIVELY. We do NOT grant screened/verified on
  //    migration (those require the check engine). We only preserve recognition
  //    and snapshot the old badge so nothing is lost; real levels are computed
  //    later. trust_level stays 'listed' until the engine runs. ───────────────
  `UPDATE projects SET
     recognition = CASE WHEN badge = 'official' THEN 'official' ELSE recognition END,
     trust_profile = jsonb_build_object(
       'legacy_badge', badge,
       'claimed',      (claimed_at IS NOT NULL),
       'has_contract', (contract IS NOT NULL OR COALESCE(array_length(contracts, 1), 0) > 0)
     ),
     trust_updated_at = NOW()`,

  // ── Backfill builder identity from existing claim state (claimed != verified) ─
  `UPDATE builder_profiles SET identity_level = 'claimed' WHERE claimed_at IS NOT NULL`,
]

;(async () => {
  console.log(`\nArcat trust-layer migration — ${APPLY ? "APPLY (writing to DB)" : "DRY RUN (no changes)"}\n`)

  const proj = await pool.query(`SELECT COUNT(*)::int n FROM projects`)
  const bld  = await pool.query(`SELECT COUNT(*)::int n FROM builder_profiles`)
  const pc   = await pool.query(`SELECT COUNT(*)::int n FROM project_contracts`).catch(() => ({ rows: [{ n: "?" }] }))
  console.log(`current: projects ${proj.rows[0].n} · builder_profiles ${bld.rows[0].n} · project_contracts ${pc.rows[0].n}`)

  console.log(`\nStatements to run:`)
  STATEMENTS.forEach((s, i) => console.log(`\n  [${i + 1}] ${s.replace(/\s+/g, " ").trim()}`))

  if (!APPLY) {
    console.log(`\n(dry run — nothing changed. Re-run with --apply to execute.)\n`)
    await pool.end()
    return
  }

  const c = await pool.connect()
  try {
    await c.query("BEGIN")
    for (const s of STATEMENTS) await c.query(s)
    await c.query("COMMIT")
    console.log(`\n✅ applied ${STATEMENTS.length} statements.`)
    const rec = await c.query(`SELECT COALESCE(recognition,'(none)') recognition, COUNT(*)::int n FROM projects GROUP BY recognition ORDER BY n DESC`)
    console.log("projects by recognition:", rec.rows)
    const idl = await c.query(`SELECT identity_level, COUNT(*)::int n FROM builder_profiles GROUP BY identity_level`)
    console.log("builders by identity_level:", idl.rows)
  } catch (e) {
    await c.query("ROLLBACK")
    console.error("✗ ROLLED BACK:", e.message)
    process.exitCode = 1
  } finally {
    c.release()
    await pool.end()
  }
})().catch(e => { console.error(e.message); process.exit(1) })
