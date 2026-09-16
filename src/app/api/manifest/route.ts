// src/app/api/manifest/route.ts
//
// Self-describing manifest for the Arcat agent: who it is and what it can
// read. Machine-readable so another agent can discover the tool surface
// without out-of-band documentation.
//
// The agent's reasoning and signing are not part of this service. This is the
// data layer it calls.

export const runtime = "nodejs"
import { NextResponse } from "next/server"
import { ARC_CHAIN_ID, USDC_ADDRESS } from "@/lib/constants"

const TOOLS = [
  { name: "ecosystem",        method: "GET", path: "/api/ecosystem",              description: "Projects on Arc, filterable by category and trust standing." },
  { name: "project",          method: "GET", path: "/api/ecosystem/{id}",         description: "A single project with its live metrics and trust standing." },
  { name: "search",           method: "GET", path: "/api/search",                 description: "Search projects, builders and addresses." },
  { name: "builders",         method: "GET", path: "/api/builders",               description: "Builder profiles and the projects they ship." },
  { name: "tvl",              method: "GET", path: "/api/tvl",                    description: "TVL, volume and revenue, with the measurement method labelled." },
  { name: "project_tvl",      method: "GET", path: "/api/tvl/{slug}",             description: "Metric history for one project, on-chain verified where available." },
  { name: "address",          method: "GET", path: "/api/address/{addr}",         description: "Address activity on Arc, USDC transfers decoded." },
  { name: "attestation",      method: "GET", path: "/api/attestation",            description: "On-chain trust attestations from the Arcat registry." },
  { name: "contracts",        method: "GET", path: "/api/project-contracts",      description: "Verified contract ownership proofs." },
  { name: "stablecoins",      method: "GET", path: "/api/stablecoins",            description: "Stablecoins on Arc with supply and issuer detail." },
  { name: "events",           method: "GET", path: "/api/events",                 description: "Arc ecosystem events." },
  { name: "trials",           method: "GET", path: "/api/trials",                 description: "Trial campaigns, tester reputation and settlement state." },
] as const

export async function GET() {
  return NextResponse.json({
    name:        "Arcat",
    kind:        "agent",
    status:      "in-development",
    description:
      "An agent for Arc. It reads the chain directly \u2014 projects, contracts, " +
      "metrics and trust standing \u2014 and settles recognition to builders in USDC. " +
      "This service is the tool and data layer it calls; the agent itself is separate.",
    chain: {
      name:    "Arc",
      chainId: ARC_CHAIN_ID,
      usdc:    USDC_ADDRESS,
    },
    tools: TOOLS,
  }, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  })
}
