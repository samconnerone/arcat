// scripts/seed-stablecoins.mjs
// Seed the curated stablecoin registry. Idempotent — re-running just upserts.
//
// Run:  node scripts/seed-stablecoins.mjs
//
// To add a new stablecoin: append it to STABLES below and re-run.
// EURC, USDT, DAI etc. addresses on Arc testnet should be added here once
// confirmed on-chain. We refuse to seed unknown addresses — accuracy first.

import { readFileSync } from "node:fs"
import pg from "pg"
import { ethers } from "ethers"

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const RPC = process.env.NEXT_PUBLIC_ARC_RPC_HTTP || "https://rpc.testnet.arc.network"
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// Curated list. Confirmed on Arc testnet only. Add new entries here
// after verifying the contract symbol/decimals from chain.
const STABLES = [
  {
    address:      "0x3600000000000000000000000000000000000000",
    symbol:       "USDC",
    name:         "USD Coin (Arc native)",
    decimals:     6,
    peg_currency: "USD",
    notes:        "Arc testnet native unit — also used to pay gas",
  },
  // To enable EURC tracking, uncomment and set the real address once confirmed:
  // {
  //   address:      "0x...",
  //   symbol:       "EURC",
  //   name:         "Euro Coin",
  //   decimals:     6,
  //   peg_currency: "EUR",
  //   notes:        "EUR-pegged. Converted to USD via daily ECB rate.",
  // },
]

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
]

async function verifyOnChain(addr, declared) {
  const provider = new ethers.JsonRpcProvider(RPC)
  const c = new ethers.Contract(addr, ERC20_ABI, provider)
  try {
    const [sym, dec] = await Promise.all([c.symbol(), c.decimals()])
    if (sym !== declared.symbol) {
      throw new Error(`symbol mismatch: chain=${sym} declared=${declared.symbol}`)
    }
    if (Number(dec) !== declared.decimals) {
      throw new Error(`decimals mismatch: chain=${dec} declared=${declared.decimals}`)
    }
    return true
  } catch (e) {
    console.warn(`  ⚠ on-chain verify failed for ${addr}: ${e.message}`)
    return false
  }
}

async function main() {
  const client = await pool.connect()
  try {
    for (const s of STABLES) {
      const addr = s.address.toLowerCase()
      console.log(`Seeding ${s.symbol} (${addr})...`)
      const verified = await verifyOnChain(addr, s)
      if (!verified) {
        console.log(`  → skipped (chain verification failed)`)
        continue
      }
      await client.query(
        `INSERT INTO stablecoins (address, symbol, name, decimals, peg_currency, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (address) DO UPDATE SET
           symbol       = EXCLUDED.symbol,
           name         = EXCLUDED.name,
           decimals     = EXCLUDED.decimals,
           peg_currency = EXCLUDED.peg_currency,
           notes        = EXCLUDED.notes`,
        [addr, s.symbol, s.name, s.decimals, s.peg_currency, s.notes ?? null]
      )
      console.log(`  ✓ upserted ${s.symbol}`)
    }

    const r = await client.query(
      `SELECT id, address, symbol, decimals, peg_currency, active
       FROM stablecoins ORDER BY id`
    )
    console.log("\n=== Stablecoin registry ===")
    for (const row of r.rows) {
      console.log(
        `  #${row.id} ${row.symbol.padEnd(6)} ${row.address}  ` +
        `decimals=${row.decimals} peg=${row.peg_currency} active=${row.active}`
      )
    }
  } catch (e) {
    console.error("Seed failed:", e)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
