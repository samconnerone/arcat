// Search tags derived from what a project actually says about itself.
//
// The directory ships descriptions truncated to 121 chars to keep the list
// payload small, so the browser can't search the full text. Instead the server
// reads the complete description once, matches it against this vocabulary, and
// ships back a handful of short tags — ~30 bytes per project instead of the
// ~300 chars of description it would otherwise take to make this searchable.
//
// Two rules learned from measuring the real data:
//
//  1. Match whole words only. Substring matching makes "ai" hit "available",
//     "chain" and "retail", which matched 215 of 310 projects and would have
//     made the filter useless.
//  2. Precision beats coverage. "vault" matches 10 projects and is the most
//     useful tag here; "stablecoin" matches 130 and barely narrows anything.
//     Ranking (see rankScore) has to stop a broad tag burying a precise one.
//
// Deliberately absent: "ai" (nearly every project claims it, so it groups
// nothing) and "testnet" (all of Arc is testnet today — revisit at mainnet).

export interface TagDef {
  tag:   string
  terms: string[]
}

export const TAG_VOCAB: TagDef[] = [
  { tag: "Vault",          terms: ["vault", "vaults"] },
  { tag: "Yield",          terms: ["yield", "staking", "stake", "apy", "apr"] },
  { tag: "Lending",        terms: ["lending", "lend", "borrow", "borrowing", "collateral", "loan", "loans"] },
  { tag: "DEX",            terms: ["dex", "swap", "swaps", "amm", "liquidity", "orderbook", "clob"] },
  { tag: "Derivatives",    terms: ["perps", "perpetual", "perpetuals", "futures", "options", "margin", "leverage", "derivatives"] },
  { tag: "Trading",        terms: ["trading", "trade", "trader", "exchange"] },
  { tag: "Stablecoin",     terms: ["stablecoin", "stablecoins", "usdc", "eurc", "usdt"] },
  { tag: "Payments",       terms: ["payments", "payment", "checkout", "invoice", "invoicing", "merchant", "merchants", "payout", "payouts", "payroll", "remittance", "remittances", "settlement"] },
  { tag: "Wallet",         terms: ["wallet", "wallets", "custody", "custodial", "multisig", "smart account", "account abstraction"] },
  { tag: "Escrow",         terms: ["escrow"] },
  { tag: "Bridge",         terms: ["bridge", "bridging", "cross-chain", "crosschain"] },
  { tag: "RWA",            terms: ["rwa", "real-world", "real world", "tokenized asset", "tokenised asset", "treasury", "treasuries"] },
  { tag: "Agents",         terms: ["agent", "agents", "agentic", "autonomous"] },
  { tag: "Prediction",     terms: ["prediction", "predictions", "betting"] },
  { tag: "NFT",            terms: ["nft", "nfts"] },
  { tag: "Marketplace",    terms: ["marketplace", "marketplaces"] },
  { tag: "Identity",       terms: ["identity", "kyc", "compliance", "attestation", "attestations"] },
  { tag: "Infrastructure", terms: ["infrastructure", "rpc", "node", "nodes", "validator", "validators", "oracle", "oracles", "indexer", "sdk"] },
  { tag: "FX",             terms: ["fx", "forex", "foreign exchange"] },
  { tag: "Launchpad",      terms: ["launchpad", "token sale", "ido", "ico"] },
  { tag: "DAO",            terms: ["dao", "governance"] },
  { tag: "Insurance",      terms: ["insurance", "underwriting"] },
]

// Roughly how many of the 310 live projects each tag covers. Used only to damp
// broad tags when ranking — a "Vault" hit means far more than a "Stablecoin" one.
const BROAD = new Set(["Stablecoin", "Payments", "Wallet", "Infrastructure", "Trading"])

// Word-boundary matcher. \b doesn't behave for terms containing "-" or spaces,
// so those are anchored on non-word characters at each end instead.
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return /[\s-]/.test(term)
    ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i")
    : new RegExp(`\\b${escaped}\\b`, "i")
}

const COMPILED: { tag: string; res: RegExp[] }[] = TAG_VOCAB.map(d => ({
  tag: d.tag,
  res: d.terms.map(termRegex),
}))

/** Tags for a project, from its full name + tagline + description. */
export function extractTags(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const { tag, res } of COMPILED) {
    if (res.some(re => re.test(text))) out.push(tag)
  }
  return out
}

/** True when a tag is broad enough that a match on it means little on its own. */
export function isBroadTag(tag: string): boolean {
  return BROAD.has(tag)
}
