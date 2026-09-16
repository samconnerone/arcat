// src/lib/deployerSig.ts
//
// Off-chain signature verification for the deployer-claim flow.
//
// Why this exists: the original /api/verify pattern required the deployer
// wallet to actively hold an Arcat session. That's wrong — deployer wallets
// are usually hardware-protected / multisig / cold storage and shouldn't be
// touching a third-party web UI for stat verification.
//
// This module verifies an off-chain personal_sign signature against the
// contract's on-chain deployer:
//   • EOA case  — ethers.verifyMessage() recovers the signer.
//   • Contract  — falls back to EIP-1271 isValidSignature(hash, sig). This
//                 covers Safe multisigs and any other smart-contract wallet
//                 that exposes the standard interface.

import { ethers } from "ethers"

// keccak256("isValidSignature(bytes32,bytes)").slice(0, 8) — bytes4 magic value.
const EIP1271_MAGIC = "0x1626ba7e"

const EIP1271_ABI = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]

export interface VerifyResult {
  ok: boolean
  method: "eoa" | "eip1271" | "none"
  recovered?: string  // populated on EOA path even when it mismatches — useful for debugging
  reason?: string
}

/**
 * Verify that `signature` over `message` (EIP-191 personal_sign envelope)
 * was produced by `claimedSigner`, supporting both EOA and EIP-1271 contract
 * wallets.
 */
export async function verifyDeployerSignature(
  message: string,
  signature: string,
  claimedSigner: string,
  provider: ethers.Provider,
): Promise<VerifyResult> {
  const claimed = (claimedSigner || "").toLowerCase()
  if (!claimed) return { ok: false, method: "none", reason: "no signer claimed" }
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, method: "none", reason: "signature is not hex" }
  }

  // 1) EOA path — direct recovery via personal_sign envelope.
  let recovered: string | undefined
  try {
    const r = ethers.verifyMessage(message, signature)
    recovered = r.toLowerCase()
    if (recovered === claimed) {
      return { ok: true, method: "eoa", recovered }
    }
  } catch {
    // verifyMessage throws on malformed signatures — fall through to EIP-1271
  }

  // 2) EIP-1271 — only meaningful when the claimed signer is itself a contract.
  let code: string
  try {
    code = await provider.getCode(claimed)
  } catch {
    return {
      ok: false, method: "eoa", recovered,
      reason: `EOA recovery returned ${recovered ?? "?"} (no contract bytecode at ${claimed} to attempt EIP-1271)`,
    }
  }
  if (code === "0x") {
    return {
      ok: false, method: "eoa", recovered,
      reason: `signature recovered to ${recovered ?? "?"}, which does not match the on-chain deployer ${claimed}`,
    }
  }

  try {
    const contract = new ethers.Contract(claimed, EIP1271_ABI, provider)
    const hash = ethers.hashMessage(message) // EIP-191 envelope hash
    const result: string = await contract.isValidSignature(hash, signature)
    if (typeof result === "string" && result.toLowerCase() === EIP1271_MAGIC) {
      return { ok: true, method: "eip1271" }
    }
    return {
      ok: false, method: "eip1271",
      reason: `deployer contract returned ${result} (expected ${EIP1271_MAGIC}) from isValidSignature`,
    }
  } catch (e: any) {
    return {
      ok: false, method: "eip1271",
      reason: `EIP-1271 call reverted: ${e?.message || e}`,
    }
  }
}

// ─── Multi-candidate authorization (the plug-and-play "proof ladder") ─────────
//
// A contract's right to be claimed shouldn't hinge on a SINGLE proof method.
// The original creator may be a factory contract, the contract may be a proxy,
// or the founder may only hold the `owner()` role today. So we resolve a SET of
// acceptable signers (creator EOA, creation-tx sender, owner()/admin(), proxy
// admin slot — assembled by the caller) and accept a signature from ANY of them.
//
// Trust is preserved: every candidate is read authoritatively from chain /
// explorer, never from the request. `method` records WHICH rung matched so the
// UI can show an honest provenance badge.

export interface AuthorizedCandidate {
  address: string   // lowercase 0x…, an on-chain-resolved authority
  method:  string   // 'deployer' | 'deployer_tx_sender' | 'owner' | 'admin' | 'proxy_admin'
}

export interface AuthorizedVerifyResult {
  ok:        boolean
  method?:   string                 // the candidate rung that matched
  proof?:    "eoa" | "eip1271"      // how it was proven
  matched?:  string                 // the candidate address that authorized
  recovered?: string
  reason?:   string
}

/**
 * Verify `signature` over `message` against a set of acceptable signers.
 * Recovers the EOA once and checks set membership; otherwise tries EIP-1271
 * against each candidate that is itself a contract (Safe etc).
 */
export async function verifyAuthorizedSigner(
  message: string,
  signature: string,
  candidates: AuthorizedCandidate[],
  provider: ethers.Provider,
): Promise<AuthorizedVerifyResult> {
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, reason: "signature is not hex" }
  }
  if (!candidates || candidates.length === 0) {
    return { ok: false, reason: "no on-chain authority could be resolved for this contract" }
  }
  const byAddr = new Map(candidates.map(c => [c.address.toLowerCase(), c]))

  // 1) EOA path — recover once, check membership in the candidate set.
  let recovered: string | undefined
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase()
    const hit = byAddr.get(recovered)
    if (hit) return { ok: true, method: hit.method, proof: "eoa", matched: hit.address, recovered }
  } catch {
    // malformed for EOA recovery — fall through to EIP-1271
  }

  // 2) EIP-1271 — try each candidate that is a smart-contract wallet.
  const hash = ethers.hashMessage(message)
  for (const c of candidates) {
    let code: string
    try { code = await provider.getCode(c.address) } catch { continue }
    if (code === "0x") continue
    try {
      const contract = new ethers.Contract(c.address, EIP1271_ABI, provider)
      const result: string = await contract.isValidSignature(hash, signature)
      if (typeof result === "string" && result.toLowerCase() === EIP1271_MAGIC) {
        return { ok: true, method: c.method, proof: "eip1271", matched: c.address }
      }
    } catch {
      // not an EIP-1271 wallet — try the next candidate
    }
  }

  const list = candidates.map(c => `${c.address.slice(0, 10)}…(${c.method})`).join(", ")
  return {
    ok: false,
    recovered,
    reason: recovered
      ? `signature recovered to ${recovered}, which isn't an authorized signer. Accepted: ${list}.`
      : `signature didn't match any authorized signer. Accepted: ${list}.`,
  }
}

/**
 * Build the canonical, human-readable message that the deployer signs.
 * The text is deliberately self-describing so a founder pasting it into a
 * hardware-wallet prompt can tell at a glance what they're authorizing.
 *
 * Fields are formatted as "key: value" on separate lines. The exact serialization
 * is stable so the server can re-construct & string-compare without parsing.
 */
export interface ChallengePayload {
  project_slug: string
  contract_address: string   // lowercase 0x…
  role: "tvl" | "revenue" | "treasury" | "volume"
  start_block?: number | null
  label?: string | null
  // Volume-only — keep undefined when role !== 'volume'.
  // volume_method = 'swap_event' (default) requires signature+arg+stablecoin.
  // volume_method = 'outflow_transfer' requires only stablecoin.
  volume_method?: "swap_event" | "outflow_transfer"
  volume_event_signature?: string
  volume_amount_arg?: number
  volume_stablecoin_id?: number
  // Required for replay protection
  nonce: string
  issued_at: string          // ISO 8601
  expires_at: string         // ISO 8601, typically +10min
  // Audit: the hot-wallet session that requested this challenge
  issued_to_wallet: string   // lowercase 0x…
}

export function buildChallengeMessage(p: ChallengePayload): string {
  const lines: string[] = [
    "Arcat contract registration",
    "",
    `project: ${p.project_slug}`,
    `contract: ${p.contract_address}`,
    `role: ${p.role}`,
  ]
  if (p.label) lines.push(`label: ${p.label}`)
  if (p.start_block != null) lines.push(`start_block: ${p.start_block}`)
  if (p.role === "volume") {
    if (p.volume_method) lines.push(`volume_method: ${p.volume_method}`)
    if (p.volume_event_signature) lines.push(`volume_event_signature: ${p.volume_event_signature}`)
    if (p.volume_amount_arg != null) lines.push(`volume_amount_arg: ${p.volume_amount_arg}`)
    if (p.volume_stablecoin_id != null) lines.push(`volume_stablecoin_id: ${p.volume_stablecoin_id}`)
  }
  lines.push(
    "",
    `issued_at: ${p.issued_at}`,
    `expires_at: ${p.expires_at}`,
    `issued_to_wallet: ${p.issued_to_wallet}`,
    `nonce: ${p.nonce}`,
    "",
    "By signing this message you authorize Arcat to display the contract's",
    "USDC/stablecoin metrics under this project. No on-chain action taken.",
  )
  return lines.join("\n")
}
