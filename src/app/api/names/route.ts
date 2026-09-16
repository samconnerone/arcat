// src/app/api/names/route.ts
// Returns registered contract names for a list of addresses
// Used by tx feeds, address pages, approval manager

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function POST(req: NextRequest) {
  try {
    const { addresses } = await req.json()
    if (!addresses?.length) return NextResponse.json({})

    const lower  = addresses.map((a: string) => a.toLowerCase())
    const result = await pool.query(
      `SELECT address, name, verified, flagged FROM contract_names_cache
       WHERE address = ANY($1)`,
      [lower]
    )

    const map: Record<string, { name: string; badge: string; type: string }> = {}
    for (const row of result.rows) {
      map[row.address] = { name: row.name, badge: row.verified ? "verified" : "claimed", type: "" }
    }

    return NextResponse.json(map, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    })
  } catch {
    return NextResponse.json({})
  }
}