// One-off: register EURC in the stablecoins table so the indexer reads EURC
// balances for TVL (and EURC transfers for revenue/volume). Until now only USDC
// was registered, so every EURC figure read as $0 / uncounted.
//
// Idempotent: no-ops if EURC is already present. EUR forex rate already exists
// (ECB), so EURC values at the live EUR→USD rate.

import { readFileSync } from "node:fs"
import pg from "pg"
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const ADDR = "0x89b50855aa3be2f677cd6303cec089b5f319d72a" // EURC on Arc testnet
const r = await pool.query(
  `INSERT INTO stablecoins (address, symbol, name, decimals, peg_currency, active, notes)
   SELECT $1, 'EURC', 'Euro Coin', 6, 'EUR', true, 'Arc testnet EURC — EUR-pegged'
   WHERE NOT EXISTS (SELECT 1 FROM stablecoins WHERE LOWER(address) = $1)
   RETURNING id`,
  [ADDR],
)
if (r.rows.length) console.log(`✓ EURC registered as stablecoin id ${r.rows[0].id} — TVL/figures will include EURC on the next cron tick (≤5 min).`)
else console.log("· EURC already registered — nothing to do.")

const all = await pool.query(`SELECT id, symbol, peg_currency, active FROM stablecoins ORDER BY id`)
console.log("registry now:", all.rows.map(s => `${s.symbol}(${s.peg_currency}${s.active ? "" : ",inactive"})`).join(", "))
await pool.end()
