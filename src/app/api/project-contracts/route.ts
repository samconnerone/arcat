// src/app/api/project-contracts/route.ts
//
// Founder-facing registry for the contracts that contribute to a project's
// TVL or revenue. Security model mirrors src/app/api/verify/route.ts:
//
//   • POST is gated by a signed-in session — the connected wallet must equal
//     the contract's on-chain deployer (fetched from arcscan, never from the
//     request body). This is what prevents one project from spoofing another's
//     contracts. Same proof of ownership we already use for contract claims.
//
//   • GET allows either a magic-link token or a session that owns the project.
//
// Successful POST also flips `projects.tvl_tracking_enabled = true` so the
// indexer starts picking up the project on the next cron tick.

import { NextRequest, NextResponse } from "next/server"
import { ethers } from "ethers"
import crypto from "crypto"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { ARC_RPC_HTTP } from "@/lib/constants"
import { canonicalEventSignature, dataArgTypes } from "@/lib/tvl"
import { getPool } from "@/lib/dbPool"
import {
  buildChallengeMessage,
  verifyAuthorizedSigner,
  type AuthorizedCandidate,
  type ChallengePayload,
} from "@/lib/deployerSig"

const pool = getPool()

const ARCSCAN = "https://testnet.arcscan.app/api/v2"

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function fetchDeployer(addr: string): Promise<string | null> {
  // Identical pattern to src/app/api/verify/route.ts — single source of truth
  // for the deployer is arcscan, never the client.
  try {
    const res = await fetch(`${ARCSCAN}/addresses/${addr}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const d = await res.json()
      if (d?.creator_address_hash) return String(d.creator_address_hash).toLowerCase()
    }
    const sc = await fetch(`${ARCSCAN}/smart-contracts/${addr}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    })
    if (sc.ok) {
      const s = await sc.json()
      const dep = s?.deployer_address || s?.creator_address_hash
      if (dep) return String(dep).toLowerCase()
    }
  } catch {}
  return null
}

// The EOA that SENT the contract-creation transaction. For factory deploys the
// arcscan `creator_address_hash` is the factory CONTRACT, but the tx sender is
// the founder's wallet that triggered it — still strong proof of authority.
async function fetchCreationTxSender(addr: string): Promise<string | null> {
  try {
    const res = await fetch(`${ARCSCAN}/addresses/${addr}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const d = await res.json()
    const txHash = d?.creation_tx_hash || d?.creation_transaction_hash
    if (!txHash) return null
    const txRes = await fetch(`${ARCSCAN}/transactions/${txHash}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    })
    if (!txRes.ok) return null
    const tx = await txRes.json()
    const from = tx?.from?.hash || tx?.from
    return from ? String(from).toLowerCase() : null
  } catch {}
  return null
}

// EIP-1967 admin storage slot: keccak256("eip1967.proxy.admin") - 1.
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const AUTHORITY_ABI = [
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function admin() view returns (address)",
]

// Resolve the SET of addresses authorized to claim this contract — the
// plug-and-play proof ladder. Every entry is read authoritatively from chain
// or explorer (never from the request). Order is informational; the verifier
// accepts a signature from ANY of them.
async function resolveAuthorizedSigners(
  addr: string,
  provider: ethers.JsonRpcProvider,
): Promise<AuthorizedCandidate[]> {
  const out: AuthorizedCandidate[] = []
  const seen = new Set<string>()
  const add = (a: string | null | undefined, method: string) => {
    if (!a) return
    const low = a.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(low) || low === ethers.ZeroAddress.toLowerCase()) return
    if (seen.has(low)) return
    seen.add(low)
    out.push({ address: low, method })
  }

  // A — direct CREATE creator (EOA for normal deploys; factory for the rest).
  add(await fetchDeployer(addr), "deployer")
  // B — creation-tx sender EOA (the founder's wallet behind a factory deploy).
  add(await fetchCreationTxSender(addr), "deployer_tx_sender")
  // C — current on-chain authority: owner()/getOwner()/admin().
  const c = new ethers.Contract(addr, AUTHORITY_ABI, provider)
  for (const [fn, method] of [["owner", "owner"], ["getOwner", "owner"], ["admin", "admin"]] as const) {
    try { add(await (c as any)[fn](), method) } catch { /* not exposed */ }
  }
  // D — EIP-1967 proxy admin slot.
  try {
    const raw = await provider.getStorage(addr, EIP1967_ADMIN_SLOT)
    if (raw && raw !== "0x" && BigInt(raw) !== BigInt(0)) add("0x" + raw.slice(-40), "proxy_admin")
  } catch { /* not a proxy */ }

  return out
}

async function fetchCreationBlock(addr: string): Promise<number | null> {
  // Best-effort start_block default; founders can override in the UI.
  try {
    const res = await fetch(`${ARCSCAN}/addresses/${addr}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const d = await res.json()
      const txHash = d?.creation_tx_hash || d?.creation_transaction_hash
      if (txHash) {
        const txRes = await fetch(`${ARCSCAN}/transactions/${txHash}`, {
          headers: { Accept: "application/json" },
          next: { revalidate: 300 },
        })
        if (txRes.ok) {
          const tx = await txRes.json()
          const bn = tx?.block_number ?? tx?.block
          if (bn != null) return Number(bn)
        }
      }
    }
  } catch {}
  return null
}

async function resolveProject(slug: string, sess: ReturnType<typeof getSession>, token: string | null) {
  // Token path mirrors /api/update-project
  if (token) {
    const r = await pool.query(
      `SELECT id, slug, owner_wallet, claim_token_expires
       FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
      [slug, token],
    )
    if (r.rows.length > 0 && new Date(r.rows[0].claim_token_expires) >= new Date()) {
      return r.rows[0]
    }
  }
  if (sess) {
    const r = await pool.query(
      `SELECT id, slug, owner_wallet
       FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2`,
      [slug, sess.addr],
    )
    if (r.rows.length > 0) return r.rows[0]
  }
  return null
}

// ─── GET — list a project's tracked contracts ────────────────────────────────
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")
  const token = req.nextUrl.searchParams.get("token")
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })

  const sess = getSession(req)
  const project = await resolveProject(slug, sess, token)
  if (!project) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  try {
    const r = await pool.query(
      `SELECT id, project_id, address, role, label, start_block,
              deployer_address, verified_at, revoked_at, revoke_reason, created_at
       FROM project_contracts
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [project.id],
    )
    return NextResponse.json({ contracts: r.rows })
  } catch (e) {
    console.error("[project-contracts GET]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

// ─── POST — register a new contract ──────────────────────────────────────────
//
// Proof model: the project owner's hot wallet sits in the SESSION. The
// deployer wallet NEVER connects — its proof comes through an EIP-191
// off-chain signature over a canonical message issued by /challenge.
//
// We accept either an EOA signature (verified via ethers.verifyMessage)
// or an EIP-1271 contract-wallet signature (verified by calling
// isValidSignature on the deployer if it's a contract — covers Safe etc).

const CHALLENGE_TTL_MS = 10 * 60 * 1000

function challengeSecret(): Buffer {
  const s = process.env.SESSION_SECRET || ""
  if (!s || s.length < 32) {
    return crypto.createHash("sha256")
      .update("arcat-dev-challenge-fallback-do-not-use-in-prod").digest()
  }
  return crypto.createHash("sha256").update(s + "::challenge").digest()
}

function verifyChallengeToken(token: string): ChallengePayload | null {
  if (!token || typeof token !== "string") return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = Buffer.from(
    crypto.createHmac("sha256", challengeSecret()).update(body).digest(),
  ).toString("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChallengePayload
    if (!payload || typeof payload !== "object") return null
    // TTL check
    const exp = Date.parse(payload.expires_at)
    if (!Number.isFinite(exp) || exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "project-contracts", { limit: 10, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const body = await req.json()
    const {
      challenge_token,
      signed_message,
      signature,
      // legacy token (magic-link) is no longer accepted for POST — read-only via GET.
    } = body

    // 1. Auth: project owner's hot-wallet session.
    const sess = getSession(req)
    if (!sess) {
      return NextResponse.json(
        { error: "Sign in first (with any wallet that owns the project)." },
        { status: 401 },
      )
    }

    // 2. Recover & TTL-check the challenge payload. This is what binds the
    //    signature to a specific (project, address, role, volume_*) tuple.
    const payload = verifyChallengeToken(challenge_token)
    if (!payload) {
      return NextResponse.json(
        { error: "Challenge token missing, expired, or tampered. Click 'Get signing message' again." },
        { status: 400 },
      )
    }

    // 3. The session that requested the challenge must equal the session
    //    submitting it. Stops one logged-in user from posting another's
    //    challenge response.
    if (payload.issued_to_wallet.toLowerCase() !== sess.addr) {
      return NextResponse.json(
        { error: "Challenge was issued to a different wallet. Re-request the signing message." },
        { status: 403 },
      )
    }

    // 4. Re-hydrate the canonical message from the payload and compare to
    //    what the founder actually signed. This catches client-side tampering.
    const expectedMessage = buildChallengeMessage(payload)
    if (typeof signed_message !== "string" || signed_message !== expectedMessage) {
      return NextResponse.json(
        { error: "Signed message doesn't match the canonical text. Sign the message exactly as shown — no edits, no extra whitespace." },
        { status: 400 },
      )
    }

    if (!signature) {
      return NextResponse.json({ error: "signature required" }, { status: 400 })
    }

    // 5. Look up the project & confirm session ownership matches.
    const proj = await pool.query(
      `SELECT id, slug FROM projects WHERE slug = $1 AND owner_wallet = $2 LIMIT 1`,
      [payload.project_slug, sess.addr],
    )
    if (proj.rows.length === 0) {
      return NextResponse.json({ error: "You don't own this project" }, { status: 403 })
    }
    const project = proj.rows[0]

    // 6. Contract sanity — must have bytecode on Arc.
    const provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP)
    const code = await provider.getCode(payload.contract_address)
    if (!code || code === "0x") {
      return NextResponse.json(
        { error: "No contract bytecode found at this address on Arc. Check the network and address." },
        { status: 400 },
      )
    }

    // 7. Resolve the SET of addresses authorized to claim this contract — read
    //    authoritatively from chain/explorer, never from the request. This is
    //    the plug-and-play proof ladder: direct creator, creation-tx sender
    //    (factory deploys), owner()/admin(), and proxy admin slot.
    const authorizedSigners = await resolveAuthorizedSigners(payload.contract_address, provider)
    if (authorizedSigners.length === 0) {
      return NextResponse.json(
        { error: "Couldn't resolve any on-chain authority for this contract on Arc. It may not be indexed yet, or arcscan is unreachable." },
        { status: 502 },
      )
    }

    // 8. Verify the off-chain signature against ANY authorized signer.
    //    EOA personal_sign first; EIP-1271 fallback for contract-wallet signers.
    const sigCheck = await verifyAuthorizedSigner(
      signed_message, signature, authorizedSigners, provider,
    )
    if (!sigCheck.ok) {
      return NextResponse.json(
        {
          error: `Signature didn't match any authorized signer for this contract. ${sigCheck.reason ?? ""}`,
          recovered: sigCheck.recovered,
          accepted_signers: authorizedSigners,
        },
        { status: 403 },
      )
    }
    // The specific address + rung that authorized the claim (for audit + badge).
    const authorizedBy = sigCheck.matched ?? authorizedSigners[0].address

    // 9. Volume-only sanity (defense in depth — same checks the /challenge
    //    endpoint already did, but values could differ if someone hand-built
    //    a token). Two methods supported with different required fields.
    let volumeTopic: string | null = null
    let volumeMethodFinal: "swap_event" | "outflow_transfer" = "swap_event"
    if (payload.role === "volume") {
      volumeMethodFinal = payload.volume_method === "outflow_transfer" ? "outflow_transfer" : "swap_event"
      const scRes = await pool.query(
        `SELECT id FROM stablecoins WHERE id = $1 AND active = true`,
        [payload.volume_stablecoin_id],
      )
      if (scRes.rows.length === 0) {
        return NextResponse.json({ error: "volume_stablecoin_id not in active registry" }, { status: 400 })
      }
      if (volumeMethodFinal === "swap_event") {
        const sig = payload.volume_event_signature
        if (!sig) {
          return NextResponse.json({ error: "Challenge payload missing volume_event_signature" }, { status: 400 })
        }
        const dataTypes = dataArgTypes(sig)
        if (dataTypes.length === 0 || (payload.volume_amount_arg ?? -1) >= dataTypes.length) {
          return NextResponse.json({ error: "Volume event arg out of range" }, { status: 400 })
        }
        volumeTopic = ethers.id(canonicalEventSignature(sig))
      }
      // outflow_transfer: no event topic needed — indexer uses the standard
      // Transfer topic and filters on `from = contract address`.
    }

    // 10. Resolve start_block.
    const currentBlock = await provider.getBlockNumber()
    let sb: number
    if (payload.start_block != null) {
      sb = Math.max(0, Math.min(currentBlock, payload.start_block))
    } else {
      const creation = await fetchCreationBlock(payload.contract_address)
      sb = creation != null ? creation : currentBlock
    }
    const addr = payload.contract_address
    const role = payload.role
    const label = payload.label

    const inserted = await pool.query(
      `INSERT INTO project_contracts
         (project_id, address, role, label, start_block,
          deployer_address, signed_message, deployer_sig, verified_at,
          volume_method, volume_event_signature, volume_event_topic, volume_amount_arg, volume_stablecoin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13)
       ON CONFLICT (project_id, address, role) DO UPDATE SET
         label                  = COALESCE(EXCLUDED.label, project_contracts.label),
         start_block            = EXCLUDED.start_block,
         revoked_at             = NULL,
         revoke_reason          = NULL,
         verified_at            = NOW(),
         signed_message         = EXCLUDED.signed_message,
         deployer_sig           = EXCLUDED.deployer_sig,
         volume_method          = EXCLUDED.volume_method,
         volume_event_signature = EXCLUDED.volume_event_signature,
         volume_event_topic     = EXCLUDED.volume_event_topic,
         volume_amount_arg      = EXCLUDED.volume_amount_arg,
         volume_stablecoin_id   = EXCLUDED.volume_stablecoin_id
       RETURNING id`,
      [
        project.id, addr, role,
        label ?? null,
        sb,
        authorizedBy,      // the on-chain authority that proved the claim
        signed_message,    // full canonical text — auditable later
        signature,         // raw signature bytes — auditable later
        payload.role === "volume" ? volumeMethodFinal : null,
        payload.role === "volume" && volumeMethodFinal === "swap_event" ? payload.volume_event_signature ?? null : null,
        payload.role === "volume" && volumeMethodFinal === "swap_event" ? volumeTopic : null,
        payload.role === "volume" && volumeMethodFinal === "swap_event" ? payload.volume_amount_arg ?? null : null,
        payload.role === "volume" ? payload.volume_stablecoin_id ?? null : null,
      ],
    )

    await pool.query(
      `UPDATE projects SET tvl_tracking_enabled = true WHERE id = $1`,
      [project.id],
    )

    return NextResponse.json({
      success: true,
      contract_id: inserted.rows[0].id,
      address: addr,
      role,
      start_block: sb,
      deployer: authorizedBy,
      verification_method: sigCheck.method,  // which rung matched: deployer / deployer_tx_sender / owner / admin / proxy_admin
      verification_proof: sigCheck.proof,    // 'eoa' or 'eip1271'
      message: "Tracked. The indexer picks it up on the next cron tick (≤5 min).",
    })
  } catch (e: any) {
    console.error("[project-contracts POST]", e)
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 })
  }
}
