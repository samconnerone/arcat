// src/app/api/address/[addr]/route.ts
// Returns transaction history for an address from YOUR indexed database.
// Falls back to Blockscout API if the indexer hasn't caught up yet.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ addr: string }> }
) {
  const { addr: rawAddr } = await params
  const addr  = rawAddr.toLowerCase()
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "20")

  try {
    // Try your own indexed DB first
    const result = await pool.query(
      `SELECT
         hash, block_number, block_time,
         from_addr, to_addr,
         value_raw, gas_used, gas_price,
         fee_usdc, status,
         is_usdc_xfer, usdc_amount, usdc_to
       FROM indexed_transactions
       WHERE from_addr = $1 OR to_addr = $1
       ORDER BY block_number DESC
       LIMIT $2`,
      [addr, limit]
    )

    if (result.rows.length > 0) {
      return NextResponse.json({
        source: "arcat_index",
        address: addr,
        transactions: result.rows.map(row => ({
          hash:        row.hash,
          blockNumber: Number(row.block_number),
          timestamp:   new Date(row.block_time).getTime() / 1000,
          from:        row.from_addr,
          to:          row.to_addr,
          valueUSDC:   "$" + (Number(row.value_raw) / 1e6).toFixed(2),
          gasUSDC:     "$" + Number(row.fee_usdc).toFixed(6),
          status:      row.status,
          isUSDC:      row.is_usdc_xfer,
          usdcAmount:  row.usdc_amount ? "$" + Number(row.usdc_amount / 1e6).toFixed(2) : null,
        })),
      })
    }

    // Fallback: Blockscout API (used until indexer has enough history)
    const bsRes  = await fetch(
      `https://testnet.arcscan.app/api/v2/addresses/${addr}/transactions?filter=to%7Cfrom`
    )
    const bsData = await bsRes.json() as { items?: Record<string, unknown>[] }

    return NextResponse.json({
      source: "blockscout_fallback",
      address: addr,
      transactions: (bsData.items || []).slice(0, limit).map(tx => {
        const fee     = tx.fee as { value?: string }
        const from    = tx.from as { hash?: string }
        const to      = tx.to as { hash?: string }
        const ts      = tx.timestamp as string
        return {
          hash:        tx.hash as string,
          blockNumber: Number(tx.block as number),
          timestamp:   ts ? Math.floor(new Date(ts).getTime() / 1000) : 0,
          from:        from?.hash || "",
          to:          to?.hash || null,
          valueUSDC:   "$" + (Number(BigInt((tx.value as string) || "0")) / 1e6).toFixed(2),
          gasUSDC:     "$" + (Number(BigInt(fee?.value || "0")) / 1e18).toFixed(6),
          status:      tx.status as string === "ok" ? "confirmed" : "failed",
          isUSDC:      false,
          usdcAmount:  null,
        }
      }),
    })

  } catch (err) {
    console.error("[Address API]", err)

    // Last resort — Blockscout only
    try {
      const bsRes  = await fetch(
        `https://testnet.arcscan.app/api/v2/addresses/${addr}/transactions?filter=to%7Cfrom`
      )
      const bsData = await bsRes.json() as { items?: Record<string, unknown>[] }
      return NextResponse.json({
        source: "blockscout_fallback",
        address: addr,
        transactions: (bsData.items || []).slice(0, limit).map(tx => {
          const fee  = tx.fee as { value?: string }
          const from = tx.from as { hash?: string }
          const to   = tx.to as { hash?: string }
          const ts   = tx.timestamp as string
          return {
            hash:        tx.hash as string,
            blockNumber: Number(tx.block as number),
            timestamp:   ts ? Math.floor(new Date(ts).getTime() / 1000) : 0,
            from:        from?.hash || "",
            to:          to?.hash || null,
            valueUSDC:   "$" + (Number(BigInt((tx.value as string) || "0")) / 1e6).toFixed(2),
            gasUSDC:     "$" + (Number(BigInt(fee?.value || "0")) / 1e18).toFixed(6),
            status:      tx.status as string === "ok" ? "confirmed" : "failed",
            isUSDC:      false,
            usdcAmount:  null,
          }
        }),
      })
    } catch {
      return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
    }
  }
}