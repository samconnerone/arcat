import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { ethers } from "ethers"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { ARC_RPC_HTTP } from "@/lib/constants"
import { verifyDeployerSignature } from "@/lib/deployerSig"
import { buildVerifyMessage } from "./challenge/route"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const PROTECTED_NAMES = ["usdc","circle","arc bridge","arcat","uniswap","aave","compound","metamask"]
const ARCSCAN        = "https://testnet.arcscan.app/api/v2"

/**
 * Fetch the actual deployer address for a contract from Blockscout.
 * Server-side fetch so callers can't spoof a deployer field in the request body.
 */
async function fetchDeployer(addr: string): Promise<string | null> {
  try {
    const res = await fetch(`${ARCSCAN}/addresses/${addr}`, { headers: { Accept: "application/json" } })
    if (!res.ok) return null
    const d = await res.json()
    let dep = d?.creator_address_hash || null
    if (!dep) {
      // Some contracts only expose deployer via the smart-contracts endpoint
      const sc = await fetch(`${ARCSCAN}/smart-contracts/${addr}`, { headers: { Accept: "application/json" } })
      if (sc.ok) {
        const s = await sc.json()
        dep = s?.deployer_address || s?.creator_address_hash || null
      }
    }
    return dep ? String(dep).toLowerCase() : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const list = req.nextUrl.searchParams.get("list")
  if (list) {
    try {
      const result = await pool.query(
        `SELECT address, name, type, description, website, twitter, badge, tx_count, created_at
         FROM contracts WHERE verified = true ORDER BY badge DESC, created_at DESC LIMIT 50`
      )
      return NextResponse.json({ contracts: result.rows })
    } catch {
      return NextResponse.json({ contracts: [] })
    }
  }
  return NextResponse.json({ error: "Invalid request" }, { status: 400 })
}

// HMAC token verification — must match /api/verify/challenge.
function challengeSecret(): Buffer {
  const s = process.env.SESSION_SECRET || ""
  if (!s || s.length < 32) {
    return crypto.createHash("sha256")
      .update("arcat-dev-challenge-fallback-do-not-use-in-prod").digest()
  }
  return crypto.createHash("sha256").update(s + "::challenge").digest()
}
function verifyChallengeToken(token: string): any | null {
  if (!token || typeof token !== "string") return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = Buffer.from(
    crypto.createHmac("sha256", challengeSecret()).update(body).digest(),
  ).toString("base64url")
  const a = Buffer.from(sig); const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (payload.kind !== "verify-claim") return null
    const exp = Date.parse(payload.expires_at)
    if (!Number.isFinite(exp) || exp < Date.now()) return null
    return payload
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "contract-verify", { limit: 10, windowMs: 60_000 })
  if (blocked) return blocked

  const body = await req.json()
  const { challenge_token, signed_message, signature, source_code, warnings } = body

  const sess = getSession(req)
  if (!sess) {
    return NextResponse.json({ error: "Sign in first (any wallet that owns the project)." }, { status: 401 })
  }

  // 1. HMAC-verify the challenge token and TTL-check.
  const payload = verifyChallengeToken(challenge_token)
  if (!payload) {
    return NextResponse.json(
      { error: "Challenge token missing, expired, or tampered. Click 'Get signing message' again." },
      { status: 400 },
    )
  }
  if (payload.issued_to_wallet?.toLowerCase() !== sess.addr) {
    return NextResponse.json(
      { error: "Challenge was issued to a different wallet — re-request." },
      { status: 403 },
    )
  }

  // 2. Reconstruct canonical message; ensure it's exactly what was signed.
  const expectedMessage = buildVerifyMessage(payload)
  if (signed_message !== expectedMessage) {
    return NextResponse.json(
      { error: "Signed message doesn't match the canonical text — sign exactly as shown." },
      { status: 400 },
    )
  }
  if (!signature) return NextResponse.json({ error: "signature required" }, { status: 400 })

  const addr = payload.contract_address
  const name = payload.name
  const type = payload.type
  const description = payload.description
  const website = payload.website
  const twitter = payload.twitter
  const email = payload.email

  // 3. Server-side fetch of the on-chain deployer (never accept client-supplied).
  const onChainDeployer = await fetchDeployer(addr)
  if (!onChainDeployer) {
    return NextResponse.json({ error: "Couldn't verify deployer on Arc. Try again in a few minutes." }, { status: 502 })
  }

  // 4. Verify the off-chain signature: EOA personal_sign OR EIP-1271 contract wallet.
  const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
  const sigCheck = await verifyDeployerSignature(signed_message, signature, onChainDeployer, provider)
  if (!sigCheck.ok) {
    return NextResponse.json(
      {
        error: `Signature did not match the on-chain deployer ${onChainDeployer.slice(0,10)}…${onChainDeployer.slice(-6)}. ${sigCheck.reason ?? ""}`,
        deployer: onChainDeployer,
      },
      { status: 403 },
    )
  }
  const deployer = onChainDeployer

  // Check if already claimed
  try {
    const existing = await pool.query("SELECT address, email FROM contracts WHERE address = $1", [addr])
    if (existing.rows.length > 0) {
      const existingEmail = existing.rows[0].email?.toLowerCase()
      const submittedEmail = email.trim().toLowerCase()
      if (existingEmail && existingEmail !== submittedEmail) {
        return NextResponse.json({ error: "This contract has already been claimed. If you are the owner, use the same email you registered with." }, { status: 409 })
      }
      // Same email = update
      await pool.query(
        `UPDATE contracts SET name=$1, type=$2, description=$3, website=$4, twitter=$5,
         source_code=COALESCE($6, source_code), verified=false, deployer=$7
         WHERE address=$8`,
        [name.trim(), type||null, description||null, website||null, twitter||null, source_code||null, deployer||null, addr]
      )
      return NextResponse.json({ success: true, updated: true })
    }
  } catch (e) {
    console.error("[Verify] DB error", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }

  // Check for protected name impersonation
  const lowerName = name.toLowerCase()
  const isProtected = PROTECTED_NAMES.some(p => lowerName.includes(p))

  // New submission
  try {
    await pool.query(
      `INSERT INTO contracts (address, name, type, description, website, twitter, email, source_code, verified, deployer, badge, flag_reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,'claimed',$10,NOW())`,
      [
        addr,
        name.trim(),
        type?.trim()||null,
        description?.trim()||null,
        website?.trim()||null,
        twitter?.trim()||null,
        email.trim(),
        source_code?.trim()||null,
        deployer?.toLowerCase()||null,
        warnings?.length > 0 || isProtected
          ? "⚠ " + (isProtected ? "Protected name. " : "") + (warnings||[]).join(" ")
          : null
      ]
    )
    return NextResponse.json({ success: true, updated: false, verified: false })
  } catch (e) {
    console.error("[Verify POST]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}