export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { verifyMessage } from "viem"
import { attachSessionCookie, clearSessionCookie, getSession } from "@/lib/session"
import { enforce } from "@/lib/ratelimit"

const SIG_MAX_AGE_MS = 5 * 60 * 1000

function buildSignInMessage(address: string, timestamp: number, nonce: string): string {
  return `Sign in to Arcat\nWallet: ${address}\nTimestamp: ${timestamp}\nNonce: ${nonce}`
}

/** GET — returns the current session if any. */
export async function GET(req: NextRequest) {
  const sess = getSession(req)
  if (!sess) return NextResponse.json({ signedIn: false })
  return NextResponse.json({ signedIn: true, address: sess.addr, type: sess.type, exp: sess.exp })
}

/**
 * POST — create a session.
 * Body for browser wallets: { type: "wallet", address, signature, timestamp, nonce }
 *
 * Circle (email-login) sessions are NOT minted here. They are issued only by the
 * email-OTP flow (/api/auth/otp/verify and /api/auth/circle/wallet), which proves
 * control of the email. Trusting a client-supplied { email, address } pair here
 * previously let anyone who knew a user's email + public wallet address sign in
 * as them — so that path has been removed.
 */
export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "session-create", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const body = await req.json()
    const address = String(body?.address || "").toLowerCase().trim()
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
    }

    if (body?.type === "wallet") {
      const { signature, timestamp, nonce } = body
      if (!signature || !timestamp || !nonce) {
        return NextResponse.json({ error: "Missing signature, timestamp, or nonce" }, { status: 400 })
      }
      const ts = Number(timestamp)
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_MAX_AGE_MS) {
        return NextResponse.json({ error: "Signature expired — try again" }, { status: 401 })
      }
      if (typeof nonce !== "string" || nonce.length < 8) {
        return NextResponse.json({ error: "Invalid nonce" }, { status: 400 })
      }
      const message = buildSignInMessage(address, ts, nonce)
      try {
        const valid = await verifyMessage({
          address:   address as `0x${string}`,
          message,
          signature: signature as `0x${string}`,
        })
        if (!valid) return NextResponse.json({ error: "Signature does not match wallet" }, { status: 401 })
      } catch {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }

      const res = NextResponse.json({ signedIn: true, address, type: "wallet" })
      attachSessionCookie(res, { addr: address, type: "wallet" })
      return res
    }

    if (body?.type === "circle") {
      // Removed: this used to mint a session from a client-supplied { email,
      // address } pair with no proof, which let anyone who knew a user's email
      // and public wallet address sign in as them. Circle sessions are now
      // issued only by the email-OTP flow (/api/auth/otp/verify, then
      // /api/auth/circle/wallet for first-time PIN setup).
      return NextResponse.json(
        { error: "Sign in with your email — verification is required." },
        { status: 400 },
      )
    }

    return NextResponse.json({ error: "Unknown sign-in type" }, { status: 400 })
  } catch (e) {
    console.error("[session POST]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

/** DELETE — sign out. */
export async function DELETE(_req: NextRequest) {
  const res = NextResponse.json({ signedIn: false })
  clearSessionCookie(res)
  return res
}
