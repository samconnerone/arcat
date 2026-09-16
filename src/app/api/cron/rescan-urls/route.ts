// src/app/api/cron/rescan-urls/route.ts
//
// Rotating URL reputation scan.
//
// The directory links out to 300+ sites nobody here controls. Any one of them
// can be compromised, expire, or turn malicious after it was listed, and this
// domain's reputation moves with them — which is exactly the exposure that
// matters when a blocklist is judging us by what we link to.
//
// Scanning by hand does not scale and the free VirusTotal tier caps us at
// 4 req/min and 500/day, so this takes a small batch every 15 minutes and
// rotates through everything: never-scanned listings first, then anything
// stuck or older than a week. ~384 checks/day, well inside the cap.
//
// Results land in `url_scans` and surface in the admin panel, where a flagged
// listing can be hidden in one click.
import { NextRequest, NextResponse } from "next/server"
import { scanNextBatch } from "@/lib/urlScan"

export const runtime = "nodejs"

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return req.headers.get("authorization") === `Bearer ${expected}`
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const r = await scanNextBatch(4)
    return NextResponse.json({ ok: true, ...r })
  } catch (e: unknown) {
    console.error("[cron/rescan-urls]", e)
    return NextResponse.json({ error: "scan failed" }, { status: 500 })
  }
}
