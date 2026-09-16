// src/app/api/project-contracts/challenge/route.ts
//
// Issues a canonical signing message + HMAC-signed token. Stateless: no
// nonce table needed because:
//   • Tampering is prevented by the HMAC over the entire payload.
//   • Replay across (contract, project, role) tuples is meaningless — the
//     POST endpoint's UNIQUE constraint dedupes the registration.
//   • Time-bounded via expires_at inside the signed payload.
//
// Flow:
//   1. Hot wallet (founder's day-to-day) calls this with the registration
//      params it wants.
//   2. We build the canonical message + an opaque token that re-encodes the
//      same params with an HMAC.
//   3. Founder copies the message, signs it OFFLINE with the deployer wallet
//      (hardware / Safe / cast / etc) — never connects that wallet to a URL.
//   4. POST /api/project-contracts receives { token, signed_message, signature };
//      server re-verifies token integrity, rebuilds the message, and checks
//      the signature against the on-chain deployer.

import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { ethers } from "ethers"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { ARC_RPC_HTTP } from "@/lib/constants"
import { dataArgTypes } from "@/lib/tvl"
import { buildChallengeMessage, type ChallengePayload } from "@/lib/deployerSig"
import { getPool } from "@/lib/dbPool"

const ARCSCAN = "https://testnet.arcscan.app/api/v2"

async function fetchDeployer(addr: string): Promise<string | null> {
  try {
    const res = await fetch(`${ARCSCAN}/addresses/${addr}`, {
      headers: { Accept: "application/json" }, next: { revalidate: 300 },
    })
    if (res.ok) {
      const d = await res.json()
      if (d?.creator_address_hash) return String(d.creator_address_hash).toLowerCase()
    }
    const sc = await fetch(`${ARCSCAN}/smart-contracts/${addr}`, {
      headers: { Accept: "application/json" }, next: { revalidate: 300 },
    })
    if (sc.ok) {
      const s = await sc.json()
      const dep = s?.deployer_address || s?.creator_address_hash
      if (dep) return String(dep).toLowerCase()
    }
  } catch {}
  return null
}

const pool = getPool()

const CHALLENGE_TTL_MS = 10 * 60 * 1000   // 10 minutes

function challengeSecret(): Buffer {
  const s = process.env.SESSION_SECRET || ""
  if (!s || s.length < 32) {
    return crypto.createHash("sha256")
      .update("arcat-dev-challenge-fallback-do-not-use-in-prod")
      .digest()
  }
  return crypto.createHash("sha256").update(s + "::challenge").digest()
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url")
}

function signToken(payload: ChallengePayload): string {
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(
    crypto.createHmac("sha256", challengeSecret()).update(body).digest(),
  )
  return `${body}.${sig}`
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "project-contracts-challenge", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  const sess = getSession(req)
  if (!sess) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  }

  try {
    const body = await req.json()
    const {
      slug, address, role, label, start_block,
      volume_method, volume_event_signature, volume_amount_arg, volume_stablecoin_id,
    } = body

    // Resolve & authorize the project.
    if (!slug)    return NextResponse.json({ error: "slug required" }, { status: 400 })
    if (!address) return NextResponse.json({ error: "address required" }, { status: 400 })
    if (!role || !["tvl", "revenue", "treasury", "volume"].includes(role)) {
      return NextResponse.json({ error: "role must be tvl, revenue, treasury, or volume" }, { status: 400 })
    }

    const addr = String(address).trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      return NextResponse.json({ error: "Invalid contract address" }, { status: 400 })
    }

    // Confirm the signed-in wallet actually owns the project. We don't need
    // their wallet to be the deployer — that proof comes via the signature
    // later. We only need to know which project they're claiming for.
    const proj = await pool.query(
      `SELECT id, slug FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2 LIMIT 1`,
      [slug, sess.addr],
    )
    if (proj.rows.length === 0) {
      return NextResponse.json({ error: "You don't own this project" }, { status: 403 })
    }

    // Volume-only validation. Two methods supported.
    let resolvedMethod: "swap_event" | "outflow_transfer" = "swap_event"
    if (role === "volume") {
      resolvedMethod = volume_method === "outflow_transfer" ? "outflow_transfer" : "swap_event"
      const scId = Number(volume_stablecoin_id)
      if (!Number.isFinite(scId)) {
        return NextResponse.json({ error: "volume_stablecoin_id required" }, { status: 400 })
      }
      if (resolvedMethod === "swap_event") {
        if (!volume_event_signature || typeof volume_event_signature !== "string") {
          return NextResponse.json({ error: "volume_event_signature required for swap_event method" }, { status: 400 })
        }
        const sig = volume_event_signature.trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/.test(sig)) {
          return NextResponse.json({ error: "volume_event_signature malformed" }, { status: 400 })
        }
        const argIdx = Number(volume_amount_arg)
        if (!Number.isFinite(argIdx) || argIdx < 0 || argIdx > 32) {
          return NextResponse.json({ error: "volume_amount_arg must be 0-based index" }, { status: 400 })
        }
        const dataTypes = dataArgTypes(sig)
        if (dataTypes.length === 0 || argIdx >= dataTypes.length) {
          return NextResponse.json({
            error: `volume_amount_arg=${argIdx} out of range against the non-indexed args in ${sig}`,
          }, { status: 400 })
        }
      }
      // outflow_transfer needs nothing else — Transfer event is universal across stablecoins.
    }

    const now = new Date()
    const expires = new Date(now.getTime() + CHALLENGE_TTL_MS)
    const payload: ChallengePayload = {
      project_slug: proj.rows[0].slug,
      contract_address: addr,
      role,
      start_block: start_block != null ? Number(start_block) : null,
      label: label ? String(label).slice(0, 80) : null,
      ...(role === "volume" ? {
        volume_method: resolvedMethod,
        ...(resolvedMethod === "swap_event" ? {
          volume_event_signature: String(volume_event_signature).trim(),
          volume_amount_arg: Number(volume_amount_arg),
        } : {}),
        volume_stablecoin_id: Number(volume_stablecoin_id),
      } : {}),
      nonce: crypto.randomBytes(16).toString("hex"),
      issued_at: now.toISOString(),
      expires_at: expires.toISOString(),
      issued_to_wallet: sess.addr,
    }

    // Look up the on-chain deployer so the client can show the founder
    // (a) which address must sign, and (b) whether the connected wallet IS
    // the deployer — in which case we can do a one-click in-browser sign
    // instead of asking the founder to copy/paste a message.
    //
    // We also do a code() check to fail fast if the address has no bytecode.
    let deployer: string | null = null
    let deployerStatus: "found" | "unindexed" | "not_a_contract" = "found"
    try {
      const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
      const code = await provider.getCode(payload.contract_address)
      if (code === "0x") {
        deployerStatus = "not_a_contract"
      } else {
        deployer = await fetchDeployer(payload.contract_address)
        if (!deployer) deployerStatus = "unindexed"
      }
    } catch {
      deployerStatus = "unindexed"
    }

    const message = buildChallengeMessage(payload)
    const token = signToken(payload)

    return NextResponse.json({
      message,
      token,
      expires_at: payload.expires_at,
      payload,
      deployer,           // lowercase 0x… or null
      deployer_status: deployerStatus,
    })
  } catch (e: any) {
    console.error("[project-contracts/challenge POST]", e)
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 })
  }
}
