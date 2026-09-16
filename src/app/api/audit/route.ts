export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// Founder submits an audit for review. Stores auditor + report URL and flags the
// project audit_status='pending'. An admin then confirms it in the editor, which
// is what actually grants Verified — submitting alone never sets the badge.
export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "audit-submit", { limit: 10, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const { token, slug, wallet, auditor, audit_url } = await req.json()
    if (!slug || !auditor?.trim() || !audit_url?.trim()) {
      return NextResponse.json({ error: "Auditor and report URL are required" }, { status: 400 })
    }
    try { new URL(audit_url) } catch { return NextResponse.json({ error: "Report URL must be a valid link" }, { status: 400 }) }

    // Auth: magic-link token OR a signed-in wallet that owns the project.
    let projectId: number | null = null
    if (token) {
      const r = await pool.query(
        `SELECT id, claim_token_expires FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
        [slug, token]
      )
      if (r.rows[0] && new Date(r.rows[0].claim_token_expires) >= new Date()) projectId = r.rows[0].id
    }
    if (!projectId && wallet) {
      const sess = getSession(req)
      const lower = String(wallet).toLowerCase()
      if (!sess || sess.addr !== lower) {
        return NextResponse.json({ error: "Sign in with the project owner wallet" }, { status: 401 })
      }
      const r = await pool.query(
        `SELECT id FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2`,
        [slug, lower]
      )
      if (r.rows[0]) projectId = r.rows[0].id
    }
    if (!projectId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

    await pool.query(
      `UPDATE projects SET auditor = $1, audit_url = $2, audit_status = 'pending' WHERE id = $3`,
      [auditor.trim().slice(0, 120), audit_url.trim().slice(0, 500), projectId]
    )
    return NextResponse.json({ success: true, message: "Submitted — we'll review your audit." })
  } catch (err) {
    console.error("[Audit POST]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
