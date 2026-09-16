// src/lib/submissionOtp.ts
//
// Email ownership check for directory submissions.
//
// Submissions used to be accepted on an address nobody had proved they owned,
// which meant every later approval or rejection email could be going to a typo,
// an abandoned inbox, or an address someone invented. That is how a sender ends
// up mailing spam traps without ever knowing it.
//
// Deliberately separate from `otp_codes` (the sign-in flow) so a founder mid-way
// through a submission can't have their code clobbered by a sign-in attempt on
// the same address, and vice versa.
import crypto from "crypto"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const CODE_TTL_MS   = 15 * 60 * 1000   // long enough to find the email
const RESEND_WAIT_MS = 60 * 1000       // between sends, per address
const MAX_ATTEMPTS   = 5

let tableReady: Promise<unknown> | null = null
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS submission_codes (
        email        TEXT PRIMARY KEY,
        code_hash    TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        attempts     INT NOT NULL DEFAULT 0,
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(e => { tableReady = null; throw e })
  }
  return tableReady
}

const PEPPER = process.env.OTP_PEPPER || "arcat-otp-pepper-v1"
const hash = (code: string) => crypto.createHash("sha256").update(code + PEPPER).digest("hex")

type Result = { ok: true } | { ok: false; error: string; status: number }

/** Email a fresh code to the submitter. Rate-limited per address. */
export async function sendSubmissionCode(email: string, projectName?: string): Promise<Result> {
  await ensureTable()

  const prior = await pool.query("SELECT last_sent_at FROM submission_codes WHERE email = $1", [email])
  if (prior.rows.length) {
    const elapsed = Date.now() - new Date(prior.rows[0].last_sent_at).getTime()
    if (elapsed < RESEND_WAIT_MS) {
      const wait = Math.ceil((RESEND_WAIT_MS - elapsed) / 1000)
      return { ok: false, error: `Please wait ${wait} seconds before requesting another code.`, status: 429 }
    }
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
  await pool.query(
    `INSERT INTO submission_codes (email, code_hash, expires_at, attempts, last_sent_at)
     VALUES ($1, $2, $3, 0, NOW())
     ON CONFLICT (email) DO UPDATE SET
       code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
       attempts = 0, last_sent_at = NOW()`,
    [email, hash(code), new Date(Date.now() + CODE_TTL_MS)],
  )

  const key = process.env.RESEND_API_KEY
  if (!key) {
    console.warn("[submissionOtp] RESEND_API_KEY not set — code not delivered")
    return { ok: false, error: "Email isn't configured right now. Please try again shortly.", status: 503 }
  }

  const who = projectName?.trim() ? ` for ${projectName.trim()}` : ""
  try {
    const { Resend } = await import("resend")
    const resend = new Resend(key)
    const res = await resend.emails.send({
      from:     (process.env.MAIL_FROM || ""),
      reply_to: process.env.TEAM_EMAIL || "",
      to:       email,
      subject:  "Confirm your Arcat submission",
      text: `Confirm your Arcat submission\n\n`
          + `Enter this code to finish submitting your project${who}:\n\n    ${code}\n\n`
          + `It expires in 15 minutes.\n\n`
          + `If you didn't submit a project to Arcat, ignore this email — nothing has been created.\n\n`
          + `Arcat`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#060c20;color:#e8ecff;">
        <div style="margin-bottom:32px;"><span style="font-size:20px;font-weight:700;color:#e8ecff;">Arc</span><span style="font-size:20px;font-weight:700;color:#1a56ff;">Arcat</span></div>
        <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#e8ecff;">Confirm your submission</h1>
        <p style="font-size:14px;color:#6b7da8;line-height:1.7;margin:0 0 20px;">Enter this code to finish submitting your project${who}. It expires in 15 minutes.</p>
        <div style="display:inline-block;padding:16px 30px;background:#0d1530;border:1px solid #1a56ff;border-radius:8px;margin-bottom:24px;">
          <span style="font-size:30px;font-weight:700;color:#ffffff;letter-spacing:9px;font-family:'Courier New',monospace;">${code}</span>
        </div>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:20px 0 14px;">
        <p style="font-size:11px;color:#6b7da8;text-align:center;line-height:1.7;">If you didn't submit a project to Arcat, ignore this email. Nothing has been created.</p>
      </div>`,
    })
    if ((res as { error?: unknown })?.error) {
      console.error("[submissionOtp] resend:", (res as { error?: unknown }).error)
      return { ok: false, error: "We couldn't send the code to that address. Check it and try again.", status: 502 }
    }
  } catch (e) {
    console.error("[submissionOtp] send failed:", e)
    return { ok: false, error: "We couldn't send the code right now. Please try again shortly.", status: 502 }
  }
  return { ok: true }
}

/** Check a submitted code. Consumed on success so it can't be replayed. */
export async function verifySubmissionCode(email: string, code: string): Promise<Result> {
  await ensureTable()
  const row = (await pool.query(
    "SELECT code_hash, expires_at, attempts FROM submission_codes WHERE email = $1", [email],
  )).rows[0]

  if (!row) return { ok: false, error: "That code has expired. Request a new one.", status: 400 }
  if (new Date(row.expires_at) < new Date()) {
    await pool.query("DELETE FROM submission_codes WHERE email = $1", [email])
    return { ok: false, error: "That code has expired. Request a new one.", status: 400 }
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await pool.query("DELETE FROM submission_codes WHERE email = $1", [email])
    return { ok: false, error: "Too many incorrect attempts. Request a new code.", status: 429 }
  }
  if (row.code_hash !== hash(code)) {
    await pool.query("UPDATE submission_codes SET attempts = attempts + 1 WHERE email = $1", [email])
    return { ok: false, error: "That code isn't right. Check the email and try again.", status: 400 }
  }

  await pool.query("DELETE FROM submission_codes WHERE email = $1", [email])
  return { ok: true }
}
