// src/app/api/verify/challenge/route.ts
//
// Issues a canonical signing message for the contract-registry claim flow.
// Same architecture as /api/project-contracts/challenge — different payload
// shape (registry stores name/type/desc/email; TVL stores role/volume_*).
//
// Returns: { message, token, deployer, deployer_status, expires_at }
// The client can compare `deployer` to the connected wallet to decide
// whether to offer one-click inline signing or the offline copy/paste path.

import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { ethers } from "ethers"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { ARC_RPC_HTTP } from "@/lib/constants"

const ARCSCAN = "https://testnet.arcscan.app/api/v2"
const CHALLENGE_TTL_MS = 10 * 60 * 1000

interface VerifyChallengePayload {
  kind: "verify-claim"
  contract_address: string
  name: string
  type?: string | null
  description?: string | null
  website?: string | null
  twitter?: string | null
  email: string
  nonce: string
  issued_at: string
  expires_at: string
  issued_to_wallet: string
}

function challengeSecret(): Buffer {
  const s = process.env.SESSION_SECRET || ""
  if (!s || s.length < 32) {
    return crypto.createHash("sha256")
      .update("arcat-dev-challenge-fallback-do-not-use-in-prod").digest()
  }
  return crypto.createHash("sha256").update(s + "::challenge").digest()
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url")
}

function signToken(payload: VerifyChallengePayload): string {
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.createHmac("sha256", challengeSecret()).update(body).digest())
  return `${body}.${sig}`
}

export function buildVerifyMessage(p: VerifyChallengePayload): string {
  const lines = [
    "Arcat contract registry claim",
    "",
    `contract: ${p.contract_address}`,
    `name: ${p.name}`,
  ]
  if (p.type) lines.push(`type: ${p.type}`)
  if (p.description) lines.push(`description: ${p.description}`)
  if (p.website) lines.push(`website: ${p.website}`)
  if (p.twitter) lines.push(`twitter: ${p.twitter}`)
  lines.push(
    `email: ${p.email}`,
    "",
    `issued_at: ${p.issued_at}`,
    `expires_at: ${p.expires_at}`,
    `issued_to_wallet: ${p.issued_to_wallet}`,
    `nonce: ${p.nonce}`,
    "",
    "By signing this message you authorize Arcat to display the contract's",
    "name and identity in the public registry. No on-chain action taken.",
  )
  return lines.join("\n")
}

async function fetchDeployer(addr: string): Promise<string | null> {
  try {
    const r = await fetch(`${ARCSCAN}/addresses/${addr}`, {
      headers: { Accept: "application/json" }, next: { revalidate: 300 },
    })
    if (r.ok) {
      const d = await r.json()
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

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "verify-challenge", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  const sess = getSession(req)
  if (!sess) return NextResponse.json({ error: "Sign in first." }, { status: 401 })

  try {
    const body = await req.json()
    const { address, name, type, description, website, twitter, email } = body
    if (!address?.trim()) return NextResponse.json({ error: "Contract address required" }, { status: 400 })
    if (!name?.trim())    return NextResponse.json({ error: "Contract name required" }, { status: 400 })
    if (!email?.trim())   return NextResponse.json({ error: "Email required" }, { status: 400 })

    const addr = String(address).trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      return NextResponse.json({ error: "Invalid contract address" }, { status: 400 })
    }

    const now = new Date()
    const expires = new Date(now.getTime() + CHALLENGE_TTL_MS)
    const payload: VerifyChallengePayload = {
      kind: "verify-claim",
      contract_address: addr,
      name: String(name).trim(),
      type: type ? String(type).trim() : null,
      description: description ? String(description).trim() : null,
      website: website ? String(website).trim() : null,
      twitter: twitter ? String(twitter).trim() : null,
      email: String(email).trim(),
      nonce: crypto.randomBytes(16).toString("hex"),
      issued_at: now.toISOString(),
      expires_at: expires.toISOString(),
      issued_to_wallet: sess.addr,
    }

    let deployer: string | null = null
    let deployerStatus: "found" | "unindexed" | "not_a_contract" = "found"
    try {
      const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
      const code = await provider.getCode(addr)
      if (code === "0x") deployerStatus = "not_a_contract"
      else {
        deployer = await fetchDeployer(addr)
        if (!deployer) deployerStatus = "unindexed"
      }
    } catch { deployerStatus = "unindexed" }

    return NextResponse.json({
      message: buildVerifyMessage(payload),
      token: signToken(payload),
      expires_at: payload.expires_at,
      deployer,
      deployer_status: deployerStatus,
    })
  } catch (e: any) {
    console.error("[verify/challenge POST]", e)
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 })
  }
}
