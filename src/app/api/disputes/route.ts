// src/app/api/disputes/route.ts
//
// Public dispute submission. Anyone can flag a number on a project — no
// auth required, just a tight rate limit + minimal sanity validation.
// The admin panel triages each entry; a project page can show an "under
// review" badge while there are open disputes against a metric.
//
// Why no auth: the dispute system is most valuable when third parties
// (auditors, competing protocols, suspicious analysts) can speak up.
// Requiring sign-in would silence the most useful voices. Abuse is
// controlled with a rate limit + the admin's right to dismiss.

import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { enforce } from "@/lib/ratelimit"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const REASON_MAX = 2_000

function hashIp(ip: string | null): string | null {
  if (!ip) return null
  return crypto.createHash("sha256").update(ip + (process.env.SESSION_SECRET ?? "")).digest("hex").slice(0, 32)
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "disputes-public", { limit: 5, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const body = await req.json()
    const { slug, metric, reason, evidence_url, reporter_email } = body

    if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })
    if (!metric || !["tvl", "revenue", "volume", "listing"].includes(metric)) {
      return NextResponse.json({ error: "metric must be tvl, revenue, volume, or listing" }, { status: 400 })
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return NextResponse.json({ error: "Please explain the issue in at least 10 characters." }, { status: 400 })
    }
    if (reason.length > REASON_MAX) {
      return NextResponse.json({ error: `Reason too long (max ${REASON_MAX} chars).` }, { status: 400 })
    }
    if (evidence_url && typeof evidence_url === "string") {
      try { new URL(evidence_url) } catch {
        return NextResponse.json({ error: "evidence_url must be a valid URL." }, { status: 400 })
      }
    }
    if (reporter_email && typeof reporter_email === "string") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporter_email)) {
        return NextResponse.json({ error: "reporter_email looks invalid." }, { status: 400 })
      }
    }

    // Resolve project_id; only allow disputes against approved/live ones.
    const proj = await pool.query<{ id: number }>(
      `SELECT id FROM projects
       WHERE (slug = $1 OR id::text = $1)
         AND approved = true AND live = true
       LIMIT 1`,
      [slug],
    )
    if (proj.rows.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            ?? req.headers.get("x-real-ip")
            ?? null
    const ipHash = hashIp(ip)

    const r = await pool.query<{ id: string }>(
      `INSERT INTO disputes (project_id, metric, reason, evidence_url, reporter_email, reporter_ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        proj.rows[0].id,
        metric,
        String(reason).trim().slice(0, REASON_MAX),
        evidence_url ? String(evidence_url).trim().slice(0, 500) : null,
        reporter_email ? String(reporter_email).trim().toLowerCase().slice(0, 200) : null,
        ipHash,
      ],
    )

    return NextResponse.json({ success: true, id: r.rows[0].id })
  } catch (e: any) {
    console.error("[disputes POST]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

// Public read of how many open disputes a project has — used by the project
// page to show an "under review" badge on the affected metric card.
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })
  try {
    const r = await pool.query<{ metric: string; n: string }>(
      `SELECT d.metric, COUNT(*)::text AS n
       FROM disputes d
       JOIN projects p ON p.id = d.project_id
       WHERE (p.slug = $1 OR p.id::text = $1)
         AND d.status = 'open'
       GROUP BY d.metric`,
      [slug],
    )
    const open: Record<string, number> = { tvl: 0, revenue: 0, volume: 0 }
    for (const row of r.rows) open[row.metric] = Number(row.n)
    return NextResponse.json(
      { open },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
    )
  } catch (e: any) {
    console.error("[disputes GET]", e)
    return NextResponse.json({ open: {} })
  }
}
