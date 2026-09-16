// src/app/api/spotlight/route.ts
//
// The Ecosystem Spotlight slot. GET returns the live, rotation-ready items
// (admin-activated, in their date window, trust-gated). POST is a founder
// application — a project owner submits their banner/copy for review (lands as
// 'pending' for an admin to approve). Admin management lives in
// /api/admin/spotlight.

export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { enforce } from "@/lib/ratelimit"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const tableReady = pool.query(`
  CREATE TABLE IF NOT EXISTS spotlight_items (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'custom',   -- campaign | event | project | custom
    title       TEXT NOT NULL,
    subtitle    TEXT,
    image_url   TEXT,
    link_url    TEXT,
    cta_text    TEXT,
    accent      TEXT,
    project_id  BIGINT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | active | rejected
    priority    INT  NOT NULL DEFAULT 0,
    starts_at   TIMESTAMPTZ,
    ends_at     TIMESTAMPTZ,
    created_by  TEXT,
    image_pos   TEXT,                                -- CSS object-position focal point
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(`ALTER TABLE spotlight_items ADD COLUMN IF NOT EXISTS image_pos TEXT`))
  .catch(e => console.error("[spotlight] table init:", e?.message || e))

// Public: the live items for the rotating banner. Trust-gated — a project-backed
// item only shows while that project is approved, live, and NOT risk-flagged.
export async function GET() {
  try {
    await tableReady
    const r = await pool.query(
      `SELECT s.id, s.kind, s.title, s.subtitle, s.image_url, s.image_pos, s.link_url, s.cta_text, s.accent
         FROM spotlight_items s
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.status = 'active'
          AND (s.starts_at IS NULL OR s.starts_at <= NOW())
          AND (s.ends_at   IS NULL OR s.ends_at   >= NOW())
          AND (s.project_id IS NULL
               OR (p.approved AND p.live AND COALESCE((p.trust_profile->>'hard_risk')::bool, false) = false))
        ORDER BY s.priority DESC, s.created_at DESC
        LIMIT 8`,
    )
    return NextResponse.json({ items: r.rows }, {
      // Spotlight items are admin-activated and rotate slowly, so a short CDN
      // cache (5 min, with a 15-min stale window) is invisible to viewers but
      // stops a fresh DB query on every single page render. Slight over-shoot
      // of an item's end-time by a few minutes is harmless.
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
    })
  } catch (e: any) {
    console.error("[spotlight GET]", e?.message || e)
    return NextResponse.json({ items: [] })
  }
}

// Founder application: a project owner submits a spotlight request. Lands as
// 'pending' for admin review. One pending request per project. Auth mirrors the
// audit flow — a valid magic-link token, OR a signed-in wallet that owns it.
export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "spotlight-apply", { limit: 5, windowMs: 60_000 })
  if (blocked) return blocked

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }) }

  const title = String(body?.title || "").trim().slice(0, 80)
  if (!title) return NextResponse.json({ error: "A title is required" }, { status: 400 })
  const slug = String(body?.slug || body?.project || "").trim()
  if (!slug) return NextResponse.json({ error: "Which project is this for?" }, { status: 400 })

  try {
    await tableReady
    // Auth: magic-link token OR a signed-in wallet that owns the project.
    let projectId: number | null = null
    let createdBy = ""
    if (body?.token) {
      const r = await pool.query(
        `SELECT id, claim_token_expires FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
        [slug, body.token],
      )
      if (r.rows[0] && new Date(r.rows[0].claim_token_expires) >= new Date()) { projectId = r.rows[0].id; createdBy = "token" }
    }
    if (!projectId && body?.wallet) {
      const sess = getSession(req)
      const lower = String(body.wallet).toLowerCase()
      if (!sess || sess.addr !== lower) return NextResponse.json({ error: "Sign in with the project owner wallet" }, { status: 401 })
      const r = await pool.query(`SELECT id FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2`, [slug, lower])
      if (r.rows[0]) { projectId = r.rows[0].id; createdBy = lower }
    }
    if (!projectId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

    // A founder can spotlight a campaign they run, or a freeform/project promo.
    const kind = ["campaign", "event", "project", "custom"].includes(body?.kind) ? body.kind : "custom"
    // Requested run length → ends_at (computed server-side). Capped at 60 days,
    // defaults to 7 days. Once it elapses the item auto-hides (GET filters on it).
    const reqH = parseInt(body?.duration_hours, 10)
    const durHours = Number.isFinite(reqH) && reqH > 0 ? Math.min(reqH, 60 * 24) : 7 * 24
    const endsAt = new Date(Date.now() + durHours * 3600 * 1000)
    // Replace any prior pending request for this project (no stacking).
    await pool.query(`DELETE FROM spotlight_items WHERE project_id = $1 AND status = 'pending'`, [projectId])
    await pool.query(
      `INSERT INTO spotlight_items (kind, title, subtitle, image_url, image_pos, link_url, cta_text, accent, project_id, status, created_by, ends_at)
       VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $11)`,
      [
        title,
        String(body?.subtitle || "").trim().slice(0, 160) || null,
        String(body?.image_url || "").trim() || null,
        String(body?.image_pos || "").trim().slice(0, 16) || null,
        String(body?.link_url || "").trim() || `/ecosystem/${slug}`,
        String(body?.cta_text || "").trim().slice(0, 24) || "Learn more",
        String(body?.accent || "").trim().slice(0, 9) || null,
        projectId,
        createdBy,
        kind,
        endsAt,
      ],
    )
    return NextResponse.json({ ok: true, message: "Submitted — we'll review your spotlight request." })
  } catch (e: any) {
    console.error("[spotlight POST]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
