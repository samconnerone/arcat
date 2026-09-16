// scripts/backup-db.mjs
// Read-only full-data snapshot of the database to JSON files.
//
// SAFE: it only runs SELECTs — it cannot modify or harm the database.
// Output goes OUTSIDE the repo (your Downloads) because it contains all data
// (emails, wallets). Keep it private — never commit or upload it.
//
//   node scripts/backup-db.mjs

import fs from "fs"
import path from "path"
import { Pool } from "pg"

const env  = fs.readFileSync(".env.local", "utf8")
const url  = env.match(/^DATABASE_URL\s*=\s*(.+)$/m)[1].trim().replace(/^["']|["']$/g, "")
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const outDir = path.join(process.env.USERPROFILE || process.env.HOME, "Downloads", `arcat-db-backup-${stamp}`)
fs.mkdirSync(outDir, { recursive: true })

// pg returns numerics as strings already, but guard BigInt just in case.
const replacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v)

;(async () => {
  const tbls = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  )
  const manifest = { taken_at: new Date().toISOString(), tables: {} }
  console.log(`Backing up ${tbls.rows.length} tables -> ${outDir}\n`)

  for (const { table_name } of tbls.rows) {
    try {
      const rows = (await pool.query(`SELECT * FROM "${table_name}"`)).rows
      fs.writeFileSync(path.join(outDir, `${table_name}.json`), JSON.stringify(rows, replacer, 0))
      manifest.tables[table_name] = rows.length
      console.log(`  ok  ${table_name.padEnd(28)} ${rows.length} rows`)
    } catch (e) {
      manifest.tables[table_name] = `ERROR: ${e.message}`
      console.log(`  !!  ${table_name.padEnd(28)} ${e.message}`)
    }
  }

  fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 2))
  const total = Object.values(manifest.tables).filter(v => typeof v === "number").reduce((a, b) => a + b, 0)
  console.log(`\nBackup complete - ${total} rows across ${tbls.rows.length} tables`)
  console.log(`Saved to: ${outDir}`)
  console.log(`(private - contains emails/wallets. do not commit or upload.)`)
  await pool.end()
})().catch(e => { console.error(e.message); process.exit(1) })
