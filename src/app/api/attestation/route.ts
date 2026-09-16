export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { subjectFor, readAttestation } from "@/lib/registry"
import { ARC_CHAIN_ID } from "@/lib/constants"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// Public read of Arcat's on-chain attestation. Anyone (wallet, app, agent) can
// also read the contract directly via RPC — this is just a pre-decoded convenience.
//   GET /api/attestation?subject=0x...   → by on-chain subject address
//   GET /api/attestation?slug=lunex      → by project (resolves its subject)
export async function GET(req: NextRequest) {
  const registry = process.env.ARCAT_REGISTRY || null
  if (!registry) {
    return NextResponse.json({ configured: false, error: "On-chain registry not configured" })
  }

  const subjectParam = req.nextUrl.searchParams.get("subject")
  const slug = req.nextUrl.searchParams.get("slug")

  let subject: string | null = null
  let projectSlug: string | null = null

  try {
    if (subjectParam && /^0x[a-fA-F0-9]{40}$/.test(subjectParam)) {
      subject = subjectParam.toLowerCase()
    } else if (slug) {
      const r = await pool.query(
        `SELECT slug,
                (SELECT address FROM project_contracts
                  WHERE project_id = projects.id AND verified_at IS NOT NULL AND revoked_at IS NULL
                  LIMIT 1) AS proven
           FROM projects WHERE slug = $1 OR id::text = $1 LIMIT 1`,
        [slug],
      )
      if (!r.rows[0]) return NextResponse.json({ error: "Project not found" }, { status: 404 })
      projectSlug = r.rows[0].slug
      subject = subjectFor({ provenContract: r.rows[0].proven, slug: r.rows[0].slug })
    } else {
      return NextResponse.json({ error: "Provide ?slug= or ?subject=" }, { status: 400 })
    }

    const attestation = await readAttestation(subject!)
    return NextResponse.json(
      { configured: true, registry, chainId: ARC_CHAIN_ID, subject, slug: projectSlug, attestation },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } },
    )
  } catch (err) {
    console.error("[attestation GET]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
