import { NextRequest, NextResponse } from "next/server"

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path")
  if (!path) return NextResponse.json({ error: "Missing path" }, { status: 400 })

  // Reject path traversal and non-API-safe characters
  if (path.includes("..") || path.startsWith("/") || !/^[a-zA-Z0-9/_\-.?=&:,]+$/.test(path)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 })
  }

  const res  = await fetch("https://testnet.arcscan.app/api/" + path)
  const data = await res.json()

  // Cache at Vercel edge — blocks/txs change fast so keep short,
  // but even 10s cache cuts invocations dramatically under load
  const isStatic = path.includes("addresses/0x000") || path.includes("tokens")
  const maxAge   = isStatic ? 120 : 20

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
    },
  })
}