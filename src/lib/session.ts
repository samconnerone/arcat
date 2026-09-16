/**
 * Stateless wallet session — HMAC-signed cookie, no DB lookup per request.
 *
 * After a user proves wallet ownership once (via signature for browser wallets,
 * or email/wallet mapping for Circle), we mint a session cookie that subsequent
 * protected endpoints accept in lieu of a fresh signature. The session token is
 * just `<payload>.<hmac>` where payload is `base64url({ addr, type, iat, exp })`.
 *
 * Because the payload is signed, an attacker can't fabricate one without the
 * server secret. Because it's not stored, we can't revoke individual sessions
 * — we wait for them to expire (7 days). The cookie is httpOnly + sameSite=lax
 * + secure (in prod) to keep it out of JS reach and CSRF-safe for GETs.
 */
import crypto from "crypto"
import type { NextRequest } from "next/server"
import type { NextResponse } from "next/server"

const SESSION_TTL_SEC = 7 * 24 * 60 * 60          // 7 days
const COOKIE_NAME     = "arcat-session"

function secret(): Buffer {
  const s = process.env.SESSION_SECRET || ""
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must be configured with at least 32 characters")
    }
    // Local-development fallback only.
    return crypto.createHash("sha256").update("arcat-dev-session-fallback-do-not-use-in-prod").digest()
  }
  return crypto.createHash("sha256").update(s).digest()
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url")
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url")
}
function hmac(payload: string): string {
  return b64url(crypto.createHmac("sha256", secret()).update(payload).digest())
}

export interface SessionData {
  addr: string                    // lowercase 0x...
  type: "wallet" | "circle"
  iat:  number                    // issued at (seconds)
  exp:  number                    // expires at (seconds)
}

export function signSession(data: Omit<SessionData, "iat" | "exp">): string {
  const now: SessionData = {
    addr: data.addr.toLowerCase(),
    type: data.type,
    iat:  Math.floor(Date.now() / 1000),
    exp:  Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  }
  const payload = b64url(JSON.stringify(now))
  return `${payload}.${hmac(payload)}`
}

export function verifySession(token: string | null | undefined): SessionData | null {
  if (!token || typeof token !== "string") return null
  const [payload, sig] = token.split(".")
  if (!payload || !sig) return null

  // Constant-time HMAC check
  const expected = hmac(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8")) as SessionData
    if (!data || !data.addr || !data.exp) return null
    if (data.exp < Math.floor(Date.now() / 1000)) return null
    return data
  } catch {
    return null
  }
}

/** Read + verify the session cookie attached to a request. */
export function getSession(req: NextRequest | Request): SessionData | null {
  const token = (req as any).cookies?.get?.(COOKIE_NAME)?.value
             ?? parseCookieHeader((req as Request).headers.get("cookie"))[COOKIE_NAME]
  return verifySession(token)
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (!k) continue
    out[k] = decodeURIComponent(rest.join("="))
  }
  return out
}

/** Attach a fresh session cookie to an outgoing response. */
export function attachSessionCookie(res: NextResponse, data: Omit<SessionData, "iat" | "exp">) {
  const value = signSession(data)
  res.cookies.set({
    name:     COOKIE_NAME,
    value,
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   SESSION_TTL_SEC,
  })
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set({
    name:     COOKIE_NAME,
    value:    "",
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   0,
  })
}

// ─── Short-lived OTP proof ────────────────────────────────────────────────────
// Set when a user completes the email OTP. It lets the wallet-finalize step
// (/api/auth/circle/wallet) mint a real session after first-time PIN setup
// WITHOUT re-trusting a client-supplied email/address pair. HMAC-signed +
// httpOnly so it can't be forged or read by JS. Verifies control of the email,
// which is the actual proof of identity for Circle (email-login) users.
const OTP_PROOF_COOKIE  = "arcat-otp-proof"
const OTP_PROOF_TTL_SEC = 15 * 60          // 15 minutes — just long enough to set a PIN

export function attachOtpProof(res: NextResponse, email: string) {
  const obj     = { email: email.toLowerCase().trim(), exp: Math.floor(Date.now() / 1000) + OTP_PROOF_TTL_SEC }
  const payload = b64url(JSON.stringify(obj))
  res.cookies.set({
    name:     OTP_PROOF_COOKIE,
    value:    `${payload}.${hmac(payload)}`,
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   OTP_PROOF_TTL_SEC,
  })
}

/** Returns the verified email if a valid, unexpired OTP-proof cookie is present, else null. */
export function readOtpProof(req: NextRequest | Request): string | null {
  const token = (req as any).cookies?.get?.(OTP_PROOF_COOKIE)?.value
             ?? parseCookieHeader((req as Request).headers.get("cookie"))[OTP_PROOF_COOKIE]
  if (!token || typeof token !== "string") return null
  const [payload, sig] = token.split(".")
  if (!payload || !sig) return null
  const expected = hmac(payload)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8")) as { email?: string; exp?: number }
    if (!data?.email || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null
    return data.email
  } catch {
    return null
  }
}

export function clearOtpProof(res: NextResponse) {
  res.cookies.set({
    name: OTP_PROOF_COOKIE, value: "", httpOnly: true,
    secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0,
  })
}

export { COOKIE_NAME as SESSION_COOKIE_NAME }
