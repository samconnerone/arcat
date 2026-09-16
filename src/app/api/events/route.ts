import { NextRequest, NextResponse } from "next/server"
import { rateLimit, getIp } from "@/lib/ratelimit"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, name, tagline, type, description, date, end_date, timezone,
              location, is_online, link, logo_url, organizer, organizer_twitter,
              tags, badge, featured, created_at
       FROM events
       WHERE approved = true
       ORDER BY featured DESC, date ASC`
    )
    return NextResponse.json({ events: result.rows }, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    })
  } catch {
    return NextResponse.json({ events: [] })
  }
}

export async function POST(req: NextRequest) {
  // Rate limit: 5 event submissions per hour per IP
  const rl = await rateLimit(`events:${getIp(req)}`, 5, 3_600_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many submissions. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    )
  }

  const body = await req.json()
  const {
    name, tagline, type, description, date, end_date, timezone,
    location, is_online, link, logo_url, organizer, organizer_twitter,
    email, tags,
  } = body

  if (!name?.trim())  return NextResponse.json({ error: "Event name required" }, { status: 400 })
  if (!date)          return NextResponse.json({ error: "Event date required" }, { status: 400 })
  if (!email?.trim()) return NextResponse.json({ error: "Contact email required" }, { status: 400 })

  try {
    const result = await pool.query(
      `INSERT INTO events
        (name, tagline, type, description, date, end_date, timezone,
         location, is_online, link, logo_url, organizer, organizer_twitter,
         email, tags, badge, approved, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'community',false,NOW())
       RETURNING id`,
      [
        name.trim(),
        tagline?.trim() || null,
        type || null,
        description?.trim() || null,
        date,
        end_date || null,
        timezone || "UTC",
        location?.trim() || null,
        is_online || false,
        link?.trim() || null,
        logo_url || null,
        organizer?.trim() || null,
        organizer_twitter?.trim() || null,
        email.trim(),
        tags || [],
      ]
    )
    return NextResponse.json({ success: true, id: result.rows[0].id })
  } catch (e) {
    console.error("[Events POST]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}