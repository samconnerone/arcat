// src/app/api/admin/spotlight/route.ts
//
// Admin management for the Ecosystem Spotlight slot:
//   GET    → every item (live, pending applications, rejected) for the panel
//   POST   → create an item (admin-authored: event / project / campaign / custom)
//   PATCH  → approve | reject | activate | deactivate | edit fields | reorder
//   DELETE → remove an item
// Auth: Bearer ${ADMIN_PASSWORD}, constant-time compared.

export const runtime = "nodejs"
import { NextRequest, NextResponse, after as runAfter } from "next/server"
import { timingSafeEqual } from "crypto"
import { getPool } from "@/lib/dbPool"
import { sendEmail, isUnsubscribed, unsubHeaders, unsubFooter, BASE_URL, FROM_ADDRESS, REPLY_TO } from "@/lib/mailer"

const pool = getPool()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""

// Notify the founder when their spotlight application is approved or rejected.
// Email is derived from the linked project; admin-authored items (created_by =
// 'admin') and items without a project email are skipped. The reject/approve
// actions only UPDATE the row (never delete it), so this is safe to defer.
async function sendSpotlightEmail(itemId: number, status: "approved" | "rejected", reason?: string) {
  try {
    const row = (await pool.query(
      `SELECT s.title, s.link_url, s.created_by, p.email, p.name AS project_name, p.slug
         FROM spotlight_items s JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1`,
      [itemId],
    )).rows[0]
    if (!row?.email || row.created_by === "admin") return
    if (await isUnsubscribed(row.email)) return

    const base  = `font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#060c20;color:#e8ecff;`
    const label = `font-size:11px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em;`
    const header = `<div style="margin-bottom:28px;"><span style="font-size:22px;font-weight:700;color:#e8ecff;">Arc</span><span style="font-size:22px;font-weight:700;color:#1a56ff;">Arcat</span></div>`
    const siteLink = row.slug ? `${BASE_URL}/ecosystem/${row.slug}` : `${BASE_URL}/ecosystem`

    if (status === "approved") {
      await sendEmail({
        from: FROM_ADDRESS, reply_to: REPLY_TO, to: row.email,
        subject: `Your Arcat spotlight is live — ${row.project_name}`,
        headers: unsubHeaders(row.email),
        html: `<div style="${base}">${header}
          <div style="${label}color:#00b87a;">Spotlight Approved</div>
          <h1 style="font-size:22px;font-weight:700;margin:10px 0 8px;color:#e8ecff;">"${row.title}" is now in the Ecosystem Spotlight</h1>
          <p style="font-size:14px;color:#6b7da8;line-height:1.8;margin:0 0 24px;">
            Your spotlight request for ${row.project_name} has been approved and is now rotating in the featured slot on the Arcat homepage and Ecosystem directory for the duration you requested.
          </p>
          <a href="${siteLink}" style="display:inline-block;padding:13px 28px;background:#1a56ff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View your listing</a>
          ${unsubFooter(row.email)}
          <p style="font-size:11px;color:#1e2a40;margin:8px 0 0;text-align:center;">⚠ We will never DM you first or ask for funds. Always verify official Arcat channels.</p>
        </div>`,
      })
    } else {
      // Mirror the project-rejection email: show the admin-picked reason in a
      // red box, or a neutral fallback when none was given.
      const reasonHtml = reason
        ? `<div style="padding:14px 18px;background:rgba(224,51,72,0.08);border:1px solid rgba(224,51,72,0.2);border-radius:8px;font-size:13px;color:#e8ecff;margin-bottom:24px;line-height:1.7;">${reason}</div>`
        : `<div style="padding:14px 18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-size:13px;color:#6b7da8;margin-bottom:24px;line-height:1.7;">No specific reason was provided. Reply to this email if you'd like more context.</div>`
      await sendEmail({
        from: FROM_ADDRESS, reply_to: REPLY_TO, to: row.email,
        subject: `Your Arcat spotlight request — ${row.project_name}`,
        headers: unsubHeaders(row.email),
        html: `<div style="${base}">${header}
          <div style="${label}color:#e03348;">Spotlight Not Approved</div>
          <h1 style="font-size:22px;font-weight:700;margin:10px 0 8px;color:#e8ecff;">Thank you for your spotlight request</h1>
          <p style="font-size:14px;color:#6b7da8;line-height:1.8;margin:0 0 16px;">
            After review, we're unable to feature "${row.title}" in the Ecosystem Spotlight at this time. The reason is noted below.
          </p>
          ${reasonHtml}
          <p style="font-size:14px;color:#6b7da8;line-height:1.8;margin:0 0 28px;">
            If this is something you can address, you're welcome to refine your banner or copy and resubmit from your dashboard. If you believe this was a mistake, simply reply to this email and we'll take another look.
          </p>
          <a href="${siteLink}" style="display:inline-block;padding:13px 28px;background:#1a56ff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View Ecosystem</a>
          ${unsubFooter(row.email)}
        </div>`,
      })
    }
  } catch (e: any) {
    console.error("[spotlight email]", e?.message || e)
  }
}

function checkAuth(pw: string): boolean {
  if (!ADMIN_PASSWORD || !pw) return false
  const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD)
  return a.length === b.length && timingSafeEqual(a, b)
}
function resolvePw(req: NextRequest): string {
  const auth = req.headers.get("authorization") || ""
  return auth.startsWith("Bearer ") ? auth.slice(7) : ""
}

const KINDS = ["campaign", "event", "project", "custom"]
function clean(v: any, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null
}

export async function GET(req: NextRequest) {
  if (!checkAuth(resolvePw(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const r = await pool.query(
      `SELECT s.*, p.name AS project_name, p.slug AS project_slug
         FROM spotlight_items s LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                 s.priority DESC, s.created_at DESC`,
    )
    const counts = {
      pending: r.rows.filter(x => x.status === "pending").length,
      active:  r.rows.filter(x => x.status === "active").length,
    }
    return NextResponse.json({ items: r.rows, counts })
  } catch (e: any) {
    console.error("[admin/spotlight GET]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(resolvePw(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const d = await req.json().catch(() => ({}))
  const title = clean(d?.title, 80)
  if (!title) return NextResponse.json({ error: "Title required" }, { status: 400 })
  const kind = KINDS.includes(d?.kind) ? d.kind : "custom"
  try {
    let projectId: number | null = null
    if (d?.project) {
      const p = (await pool.query(`SELECT id FROM projects WHERE slug = $1 OR id::text = $1 LIMIT 1`, [String(d.project)])).rows[0]
      projectId = p?.id ?? null
    }
    const r = await pool.query(
      `INSERT INTO spotlight_items (kind, title, subtitle, image_url, image_pos, link_url, cta_text, accent, project_id, status, priority, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'admin') RETURNING id`,
      [
        kind, title, clean(d?.subtitle, 160), clean(d?.image_url, 500), clean(d?.image_pos, 16),
        clean(d?.link_url, 500), clean(d?.cta_text, 24), clean(d?.accent, 9),
        projectId, "active", // admin-created items go live immediately
        Number.isFinite(Number(d?.priority)) ? Number(d.priority) : 0,
        d?.starts_at || null, d?.ends_at || null,
      ],
    )
    return NextResponse.json({ ok: true, id: r.rows[0].id })
  } catch (e: any) {
    console.error("[admin/spotlight POST]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  if (!checkAuth(resolvePw(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const d = await req.json().catch(() => ({}))
  const id = Number(d?.id)
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 })
  const action = d?.action as string
  try {
    if (action === "approve" || action === "activate") {
      await pool.query(`UPDATE spotlight_items SET status = 'active' WHERE id = $1`, [id])
      // Notify the applicant only on a real approval — not on re-activating an
      // admin item that was toggled off (created_by='admin' is skipped anyway).
      if (action === "approve") runAfter(() => sendSpotlightEmail(id, "approved"))
    } else if (action === "reject") {
      const reason = clean(d?.reason, 500) || undefined
      await pool.query(`UPDATE spotlight_items SET status = 'rejected' WHERE id = $1`, [id])
      runAfter(() => sendSpotlightEmail(id, "rejected", reason))
    } else if (action === "deactivate") {
      await pool.query(`UPDATE spotlight_items SET status = 'pending' WHERE id = $1`, [id])
    } else if (action === "edit") {
      await pool.query(
        `UPDATE spotlight_items SET
           title = COALESCE($2, title), subtitle = $3, image_url = $4, link_url = $5,
           cta_text = $6, accent = $7, priority = COALESCE($8, priority),
           starts_at = $9, ends_at = $10, image_pos = $11
         WHERE id = $1`,
        [id, clean(d?.title, 80), clean(d?.subtitle, 160), clean(d?.image_url, 500),
         clean(d?.link_url, 500), clean(d?.cta_text, 24), clean(d?.accent, 9),
         Number.isFinite(Number(d?.priority)) ? Number(d.priority) : null,
         d?.starts_at || null, d?.ends_at || null, clean(d?.image_pos, 16)],
      )
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error("[admin/spotlight PATCH]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(resolvePw(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = Number(new URL(req.url).searchParams.get("id"))
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 })
  try {
    await pool.query(`DELETE FROM spotlight_items WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error("[admin/spotlight DELETE]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
