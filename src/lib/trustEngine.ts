// src/lib/trustEngine.ts
//
// Trust check-engine. Reads real signals (on-chain contract checks + website
// safety) into an ADVISORY profile an admin sees while MANUALLY setting a
// project's trust level. It also detects a HIGH-CONFIDENCE hard risk (website on
// the scam list; sanctions later) that auto-overrides a project to red. It never
// sets the trust level itself, never writes on-chain, never touches `badge`.
// Heuristics (mint/pause/unverified-source) are advisory only — never auto-red.

import { ethers } from "ethers"
import { ARC_RPC_HTTP } from "./constants"

const ARCSCAN = "https://testnet.arcscan.app/api/v2"
const EIP1967_IMPL  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
// MetaMask's open crypto-phishing list — the data behind its "Deceptive site
// ahead" warning. Free, no key. (Google Safe Browsing can be layered in later.)
const MM_LIST = "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json"

// Powers worth surfacing for review (substring match on function names). These
// are FLAGS, not auto-fails — a DEX legitimately mints LP tokens, etc.
const POWER_FLAGS = ["mint", "blacklist", "blocklist", "freeze", "pause", "drain", "withdrawall", "sweep", "seize", "selfdestruct", "setfee"]

export type PhishingList = { block: Set<string>; allow: Set<string> }
export type WebsiteVerdict = "no_website" | "clean" | "known_good" | "flagged" | "unknown"

export interface ContractRow { address: string; role: string; verified: boolean }
export interface ContractAnalysis {
  address: string; role: string; isContract: boolean
  deployerVerified: boolean; sourceVerified: boolean
  upgradeable: boolean; adminType: string; ownership: string; powers: string[]
}

export type TrustLevel = "listed" | "claimed" | "vetted" | "verified" // valid manual values
export interface Assessment { hardRisk: boolean; profile: any }

let _provider: ethers.JsonRpcProvider | null = null
function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(ARC_RPC_HTTP, { chainId: 5042002, name: "arc-testnet" })
  return _provider
}

// ── Website safety ───────────────────────────────────────────────────────────
export async function loadPhishingList(): Promise<PhishingList | null> {
  try {
    const r = await fetch(MM_LIST)
    if (!r.ok) return null
    const d: any = await r.json()
    return {
      block: new Set<string>((d.blacklist || []).map((s: string) => s.toLowerCase())),
      allow: new Set<string>((d.whitelist || []).map((s: string) => s.toLowerCase())),
    }
  } catch { return null }
}
export function hostOf(website?: string | null): string | null {
  if (!website) return null
  try { return new URL(website.startsWith("http") ? website : "https://" + website).hostname.toLowerCase().replace(/^www\./, "") } catch { return null }
}
export function checkWebsite(host: string | null, list: PhishingList | null): WebsiteVerdict {
  if (!host) return "no_website"
  if (!list) return "unknown"
  if (list.block.has(host)) return "flagged"
  if (list.allow.has(host)) return "known_good"
  return "clean"
}

// ── Contract safety (single deterministic reads — reliable on any RPC) ─────────
export async function analyzeContract(c: ContractRow): Promise<ContractAnalysis> {
  const p = provider()
  const addr = c.address
  const out: ContractAnalysis = {
    address: addr, role: c.role, isContract: false,
    deployerVerified: !!c.verified, sourceVerified: false,
    upgradeable: false, adminType: "n/a", ownership: "unknown", powers: [],
  }
  try { const code = await p.getCode(addr); out.isContract = !!code && code !== "0x" } catch {}
  try {
    const r = await fetch(`${ARCSCAN}/smart-contracts/${addr}`, { headers: { Accept: "application/json" } })
    if (r.ok) {
      const d: any = await r.json()
      out.sourceVerified = !!d.is_verified
      if (Array.isArray(d.abi)) {
        const fns = d.abi.filter((x: any) => x.type === "function").map((x: any) => (x.name || "").toLowerCase())
        out.powers = POWER_FLAGS.filter(pw => fns.some((n: string) => n.includes(pw)))
      }
    }
  } catch {}
  try {
    const impl = await p.getStorage(addr, EIP1967_IMPL)
    if (impl && BigInt(impl) !== 0n) {
      out.upgradeable = true
      const adm = await p.getStorage(addr, EIP1967_ADMIN)
      if (adm && BigInt(adm) !== 0n) {
        const a = "0x" + adm.slice(-40)
        const code = await p.getCode(a)
        out.adminType = code && code !== "0x" ? "contract" : "eoa"
      }
    }
  } catch {}
  try {
    const ct = new ethers.Contract(addr, ["function owner() view returns (address)", "function admin() view returns (address)"], p)
    let o: string | null = null
    try { o = await (ct as any).owner() } catch { try { o = await (ct as any).admin() } catch {} }
    if (o) {
      if (BigInt(o) === 0n) out.ownership = "renounced"
      else { const code = await p.getCode(o); out.ownership = code && code !== "0x" ? "multisig" : "eoa" }
    }
  } catch {}
  return out
}

// ── Assess a project: advisory facts + a high-confidence hard-risk flag ────────
// Does NOT set the trust level (an admin does that manually). It builds the
// advisory profile the admin decides with, and flags a HARD risk only on
// confirmed-bad signals (website on the scam list; sanctions later) — never on
// heuristics like mint/pause/unverified-source, which are legit for many teams.
export function assessProject(args: {
  websiteVerdict: WebsiteVerdict
  contracts: ContractAnalysis[]
}): Assessment {
  const { websiteVerdict, contracts } = args
  const hardRisk = websiteVerdict === "flagged" // scam-list hit (sanctions added later)

  // CAUTION = soft, admin-only signals worth a glance — NOT a red flag. We keep
  // these RARE and meaningful, never flagging innocent teams. NOTE: "source not
  // verified on the explorer" is deliberately NOT a caution — on a new chain
  // almost no one verifies source yet, so it would flag nearly everyone (noise).
  // It stays as a per-contract data point in the profile for reference only.
  const real = contracts.filter(c => c.isContract)
  const cautions: string[] = []
  if (real.some(c => c.upgradeable && c.adminType === "eoa")) cautions.push("a contract is upgradeable by a single wallet")
  const caution = !hardRisk && cautions.length > 0

  const profile = {
    computed_at: new Date().toISOString(),
    website: { verdict: websiteVerdict },
    contracts: contracts.map(c => ({
      address: c.address, role: c.role, is_contract: c.isContract,
      deployer_verified: c.deployerVerified, source_verified: c.sourceVerified,
      upgradeable: c.upgradeable, admin: c.adminType, ownership: c.ownership,
      powers_to_review: c.powers, // advisory only — never auto-flips a badge
    })),
    hard_risk: hardRisk,
    risk_reason: hardRisk ? "website on MetaMask scam list" : null,
    caution,                       // soft, user-facing
    caution_reasons: cautions,
    caution_note: caution ? "Worth checking: " + cautions.join("; ") + "." : null,
  }
  return { hardRisk, profile }
}

// Objective "Vetted" predicate. A project is Vetted when it has registered
// contracts and EVERY one has verified source on the explorer, with no hard
// risk. Source verification is the meaningful, checkable bar (code is open and
// matches the deployed bytecode — most scams fail it). Powers/upgradeability
// stay advisory only, since they're legitimate for many real teams. No human
// judgment — safe to run automatically.
export function passesVetting(profile: any): boolean {
  if (!profile || profile.hard_risk) return false
  const cs = profile.contracts || []
  return cs.length > 0 && cs.every((c: any) => c.source_verified === true)
}
