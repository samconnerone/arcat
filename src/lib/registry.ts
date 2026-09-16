// src/lib/registry.ts
// Writes Arcat trust attestations on-chain to ArcatRegistry.
//
// ENV-GATED: it no-ops gracefully until both ARCAT_REGISTRY (the deployed
// contract address) and ATTESTER_PRIVATE_KEY (a dedicated attester wallet,
// funded with a little USDC for gas) are set. So the rest of the app works now;
// the chain writes switch on the moment those are configured.
//
// Subject = the project's primary contract address. Projects without a contract
// have no on-chain subject (DB-only); the registry attests contracts.

import { createWalletClient, createPublicClient, http, keccak256, toBytes, type Chain } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ARC_RPC_HTTP, ARC_CHAIN_ID } from "./constants"

const ABI = [
  { type: "function", name: "attest", stateMutability: "nonpayable", inputs: [{ name: "subject", type: "address" }, { name: "tier", type: "uint8" }, { name: "ref", type: "string" }], outputs: [] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "subject", type: "address" }], outputs: [] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "subject", type: "address" }], outputs: [{ name: "tier", type: "uint8" }, { name: "issuedAt", type: "uint64" }, { name: "revoked", type: "bool" }, { name: "ref", type: "string" }] },
] as const

// trust_level / recognition → on-chain tier (recognition outranks the earned level).
const TIER: Record<string, number> = { listed: 1, claimed: 2, vetted: 3, verified: 4, arc_partner: 5, arc_official: 6 }
export const TIER_LABEL: Record<number, string> = { 0: "none", 1: "listed", 2: "claimed", 3: "vetted", 4: "verified", 5: "arc_partner", 6: "arc_official" }

/** The on-chain subject for a project: its proven (registered) contract if it has
 *  one, otherwise a deterministic project-id address derived from the slug. This
 *  lets EVERY project be attested — contract or not — and the synthetic address
 *  can't be impersonated (it's just an Arcat project identifier, not a real
 *  contract). Same function used to attest and to read back. */
export function subjectFor(opts: { provenContract?: string | null; slug?: string | null }): string | null {
  const c = opts.provenContract
  if (c && /^0x[a-fA-F0-9]{40}$/.test(c)) return c.toLowerCase()
  if (opts.slug) return ("0x" + keccak256(toBytes("arcat:project:" + opts.slug)).slice(-40)).toLowerCase()
  return null
}

const GET_ABI = [
  { type: "function", name: "get", stateMutability: "view", inputs: [{ name: "subject", type: "address" }], outputs: [{ name: "tier", type: "uint8" }, { name: "issuedAt", type: "uint64" }, { name: "revoked", type: "bool" }, { name: "ref", type: "string" }] },
] as const

// Established is orthogonal to the tier ladder (a project can be Claimed AND
// Established), and the deployed contract only stores tier + ref. So we record
// Established on-chain as a marker in the ref string — provable by anyone who
// reads the attestation, without redeploying the contract.
const EST_MARKER = "#established"

/** Read the current attestation for a subject straight from the chain. */
export async function readAttestation(subject: string): Promise<{ tier: number; tierLabel: string; issuedAt: number; revoked: boolean; ref: string; established: boolean; isVerified: boolean } | null> {
  const address = process.env.ARCAT_REGISTRY
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(subject)) return null
  try {
    const pub = createPublicClient({ chain: arc, transport: http(ARC_RPC_HTTP) })
    const r = await (pub as any).readContract({ address, abi: GET_ABI, functionName: "get", args: [subject] }) as readonly [number, bigint, boolean, string]
    const tier = Number(r[0])
    const ref = r[3] || ""
    return { tier, tierLabel: TIER_LABEL[tier] || "none", issuedAt: Number(r[1]), revoked: r[2], ref, established: ref.includes(EST_MARKER), isVerified: tier >= 4 && !r[2] && Number(r[1]) > 0 }
  } catch { return null }
}

const arc: Chain = {
  id: ARC_CHAIN_ID,
  name: "arc-testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_HTTP] } },
}

function config() {
  const address = process.env.ARCAT_REGISTRY
  const pk = process.env.ATTESTER_PRIVATE_KEY
  if (!address || !pk) return null
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : "0x" + pk) as `0x${string}`)
  const wallet = createWalletClient({ account, chain: arc, transport: http(ARC_RPC_HTTP) })
  return { address: address as `0x${string}`, wallet }
}

export function registryConfigured(): boolean {
  return !!(process.env.ARCAT_REGISTRY && process.env.ATTESTER_PRIVATE_KEY)
}

/** Write/refresh the attestation for a contract. tier from trust_level + recognition. */
export async function attestOnChain(
  subject: string,
  trust_level: string | null | undefined,
  recognition: string | null | undefined,
  ref = "",
  established = false,
): Promise<{ hash?: string; tier?: number; skipped?: boolean; error?: string }> {
  const c = config()
  if (!c) return { skipped: true }
  if (!/^0x[a-fA-F0-9]{40}$/.test(subject)) return { skipped: true }
  const key = recognition === "official" ? "arc_official" : recognition === "partner" ? "arc_partner" : (trust_level || "listed")
  const tier = TIER[key] ?? 1
  // Established rides in the ref as a marker so it's recorded + readable on-chain.
  const finalRef = established ? (ref ? `${ref}${EST_MARKER}` : EST_MARKER) : ref
  try {
    const hash = await c.wallet.writeContract({ address: c.address, abi: ABI, functionName: "attest", args: [subject as `0x${string}`, tier, finalRef], chain: arc, account: c.wallet.account })
    return { hash, tier }
  } catch (e: any) {
    return { error: e?.message || String(e) }
  }
}

/** Revoke on-chain (risk-flagged or removed) — flips isVerified to false. */
export async function revokeOnChain(subject: string): Promise<{ hash?: string; skipped?: boolean; error?: string }> {
  const c = config()
  if (!c) return { skipped: true }
  if (!/^0x[a-fA-F0-9]{40}$/.test(subject)) return { skipped: true }
  try {
    const hash = await c.wallet.writeContract({ address: c.address, abi: ABI, functionName: "revoke", args: [subject as `0x${string}`], chain: arc, account: c.wallet.account })
    return { hash }
  } catch (e: any) {
    return { error: e?.message || String(e) }
  }
}
