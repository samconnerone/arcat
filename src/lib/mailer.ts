// src/lib/mailer.ts
//
// Shared transactional-email helpers. Extracted so routes beyond the main admin
// route (e.g. spotlight approvals) can send founder emails with the same sender,
// unsubscribe handling, and graceful no-op when RESEND_API_KEY isn't configured.
// The main admin route keeps its own inline copies for now — this does NOT touch
// that working path.
import { Resend } from "resend"
import { getPool } from "@/lib/dbPool"
import { createUnsubscribeToken } from "@/lib/unsubscribeToken"

const pool = getPool()

export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"
export const FROM_ADDRESS = (process.env.MAIL_FROM || "")
export const REPLY_TO = process.env.TEAM_EMAIL || ""

// Build the client per-call so a missing key can't crash the route at module
// load — calls no-op gracefully when Resend isn't available (e.g. local dev).
let _resend: Resend | null = null
function client(): Resend | null {
  if (_resend) return _resend
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  try { _resend = new Resend(key); return _resend } catch { return null }
}

// Drop-in `resend.emails.send(...)` that no-ops (and logs) when Resend isn't
// configured, so callers never fail just because email sending is unavailable.
export async function sendEmail(opts: Parameters<Resend["emails"]["send"]>[0]) {
  const r = client()
  if (!r) { console.warn("[mailer] RESEND_API_KEY not set — email skipped"); return { data: null, error: null } }
  return r.emails.send(opts)
}

export function unsubFooter(email: string) {
  const link = `${BASE_URL}/api/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(email))}`
  return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:32px 0;">
    <p style="font-size:11px;color:#1e2a40;text-align:center;line-height:1.8;">
      You're receiving this because you submitted a project or campaign on Arcat.<br>
      <a href="${link}" style="color:#2e3a5c;text-decoration:underline;">Unsubscribe</a>
    </p>`
}

export function unsubHeaders(email: string) {
  const url = `${BASE_URL}/api/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(email))}`
  return {
    "List-Unsubscribe": `<${url}>, <mailto:${process.env.TEAM_EMAIL || ""}?subject=unsubscribe&body=${encodeURIComponent(email)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }
}

export async function isUnsubscribed(email: string): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM email_unsubscribes WHERE email = $1`, [email.toLowerCase().trim()])
    return r.rows.length > 0
  } catch {
    return false
  }
}
