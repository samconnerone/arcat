export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { enforce } from "@/lib/ratelimit"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const tableReady = pool.query(`
  CREATE TABLE IF NOT EXISTS otp_codes (
    email         TEXT PRIMARY KEY,
    code_hash     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      INT NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(e => console.error("[otp/send] table init:", e))

const PEPPER = process.env.OTP_PEPPER || process.env.SESSION_SECRET || "arcat-dev-otp-pepper-v1"

function hashCode(code: string): string {
  return crypto.createHmac("sha256", PEPPER).update(code).digest("hex")
}

function brandedHTML(code: string): string {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#060c20;color:#e8ecff;">
  <div style="margin-bottom:32px;">
    <span style="font-size:20px;font-weight:700;color:#e8ecff;">Arc</span><span style="font-size:20px;font-weight:700;color:#1a56ff;">Arcat</span>
  </div>
  <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#e8ecff;">Your sign-in code</h1>
  <p style="font-size:14px;color:#6b7da8;line-height:1.7;margin:0 0 8px;">Use the code below to finish signing in to Arcat.</p>
  <p style="font-size:13px;color:#6b7da8;line-height:1.7;margin:0 0 28px;">It expires in 10 minutes. Never share this code with anyone.</p>
  <div style="display:inline-block;padding:18px 32px;background:#0d1530;border:1px solid #1a56ff;border-radius:8px;margin-bottom:28px;">
    <span style="font-size:34px;font-weight:700;color:#ffffff;letter-spacing:10px;font-family:'Courier New',monospace;">${code}</span>
  </div>
  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0 16px;">
  <p style="font-size:11px;color:#6b7da8;text-align:center;line-height:1.7;margin:0 0 8px;">Arcat will never ask you for a seed phrase, private key, or wallet password.</p>
  <p style="font-size:11px;color:#1e2a40;text-align:center;">If you didn't request this code, you can safely ignore this email. Your account stays safe.</p>
</div>`
}

// Plain-text alternative. The HTML-only version was 27% text by weight, which
// filters read as markup-heavy and score down. Sending both parts is also what
// a legitimate transactional sender does.
function plainText(code: string): string {
  return `Your Arcat sign-in code

Use this code to finish signing in to Arcat:

    ${code}

It expires in 10 minutes. Never share this code with anyone.

Arcat will never ask you for a seed phrase, private key, or wallet
password. We only ever send you to our own domain

If you didn't request this code, you can safely ignore this email.
Your account stays safe.

Arcat`
}

export async function POST(req: NextRequest) {
  try {
    // Global IP rate limit — defends against Resend bill spikes from spam
    const blocked = await enforce(req, "otp-send", { limit: 10, windowMs: 60_000 })
    if (blocked) return blocked

    const { email } = await req.json()
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 })
    }
    const lower = email.toLowerCase().trim()

    await tableReady

    // Rate limit: 30 seconds between sends per email
    const prior = await pool.query("SELECT last_sent_at FROM otp_codes WHERE email = $1", [lower])
    if (prior.rows.length) {
      const elapsedMs = Date.now() - new Date(prior.rows[0].last_sent_at).getTime()
      if (elapsedMs < 30_000) {
        return NextResponse.json(
          { error: `Please wait ${Math.ceil((30_000 - elapsedMs) / 1000)} seconds before requesting a new code` },
          { status: 429 }
        )
      }
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
    const codeHash = hashCode(code)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    // Persist OTP first so verification works even if email is slow
    const dbPromise = pool.query(
      `INSERT INTO otp_codes (email, code_hash, expires_at, attempts, last_sent_at)
       VALUES ($1, $2, $3, 0, NOW())
       ON CONFLICT (email) DO UPDATE SET
         code_hash    = EXCLUDED.code_hash,
         expires_at   = EXCLUDED.expires_at,
         attempts     = 0,
         last_sent_at = NOW()`,
      [lower, codeHash, expiresAt]
    )

    const { Resend } = await import("resend")
    const resend = new Resend(process.env.RESEND_API_KEY || "")

    const emailPromise = resend.emails.send({
      from:     (process.env.MAIL_FROM || ""),
      reply_to: process.env.TEAM_EMAIL || "",
      to:       lower,
      subject:  "Your Arcat sign-in code",
      html:     brandedHTML(code),
      text:     plainText(code),
    })

    const [, emailResult] = await Promise.all([dbPromise, emailPromise])
    if ((emailResult as any)?.error) {
      console.error("[otp/send] resend:", (emailResult as any).error)
      return NextResponse.json({ error: "Failed to send email. Please try again." }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error("[otp/send]", e)
    return NextResponse.json({ error: "Failed to send code" }, { status: 500 })
  }
}
