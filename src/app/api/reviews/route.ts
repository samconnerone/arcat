import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const CATEGORIES = ["Product Experience", "Performance", "UI/UX", "Customer Support", "Security", "Feature Request"]

type ActivityResult = "active" | "inactive" | "unavailable"

// A review used to depend entirely on Arcscan's counters endpoint. A timeout or
// a small response-shape change therefore looked exactly like a wallet with no
// activity and blocked real Arc users. Check the chain RPC and Arcscan in
// parallel, and only call a wallet inactive when both services answered zero.
async function getWalletActivity(wallet: string): Promise<ActivityResult> {
  const rpcUrl = process.env.ARC_RPC_HTTP || "https://rpc.testnet.arc.network"
  const explorerBase = process.env.ARC_EXPLORER_API || "https://testnet.arcscan.app/api/v2"

  const [rpc, explorer] = await Promise.allSettled([
    fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [wallet, "latest"], id: 1 }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    }).then(async res => {
      if (!res.ok) throw new Error(`RPC returned ${res.status}`)
      const data = await res.json()
      if (typeof data?.result !== "string" || !/^0x[0-9a-f]+$/i.test(data.result)) {
        throw new Error("RPC returned no transaction count")
      }
      return BigInt(data.result) > 0n
    }),
    fetch(`${explorerBase}/addresses/${wallet}/counters`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    }).then(async res => {
      if (!res.ok) throw new Error(`Explorer returned ${res.status}`)
      const data = await res.json()
      const raw = data?.transactions_count ?? data?.transaction_count
      if (raw == null || !Number.isFinite(Number(raw))) {
        throw new Error("Explorer returned no transaction count")
      }
      return Number(raw) > 0
    }),
  ])

  const answers = [rpc, explorer]
    .filter((r): r is PromiseFulfilledResult<boolean> => r.status === "fulfilled")
    .map(r => r.value)

  if (answers.includes(true)) return "active"
  if (answers.length === 2) return "inactive"
  return "unavailable"
}

async function getWalletBadge(wallet: string, contract: string | null): Promise<string> {
  if (contract) {
    try {
      const res = await fetch(
        `https://testnet.arcscan.app/api/v2/addresses/${wallet}/transactions?filter=to&limit=10`,
        { cache: "no-store", signal: AbortSignal.timeout(4000) }
      )
      if (!res.ok) throw new Error(`Explorer returned ${res.status}`)
      const data = await res.json()
      const txs = data?.items || []
      const usedContract = txs.some((tx: any) =>
        tx.to?.hash?.toLowerCase() === contract.toLowerCase()
      )
      if (usedContract) return "verified"
    } catch {
      // Contract-specific verification is a stronger badge, not a requirement
      // to review. Fall through to the resilient general activity check.
    }
  }

  const activity = await getWalletActivity(wallet)
  if (activity === "active") return "arc_user"
  if (activity === "unavailable") return "activity_unavailable"
  return "unverified"
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ reviews: [] })

  try {
    const result = await pool.query(
      `SELECT id, wallet, category, rating, review_text, badge, contact, created_at
       FROM reviews
       WHERE project_id = $1 AND is_public = true
       ORDER BY created_at DESC
       LIMIT 50`,
      [projectId]
    )
    return NextResponse.json({ reviews: result.rows }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    })
  } catch {
    return NextResponse.json({ reviews: [] })
  }
}

export async function POST(req: NextRequest) {
  try {
    const blocked = await enforce(req, "review-submit", { limit: 10, windowMs: 60_000 })
    if (blocked) return blocked

    const body = await req.json()
    const { project_id, wallet, category, rating, review_text, is_public, contact } = body

    if (!project_id || !wallet || !category || !rating || !review_text?.trim()) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Session check: only the wallet owner can submit reviews as themselves.
    // Without this, anyone who knew a wallet that had used the contract could
    // submit a fake review under that wallet, capped by the duplicate check.
    const sess = getSession(req)
    if (!sess || sess.addr !== String(wallet).toLowerCase()) {
      return NextResponse.json({ error: "Sign in with the reviewing wallet to leave a review" }, { status: 401 })
    }
    if (!CATEGORIES.includes(category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 })
    }
    if (rating < 1 || rating > 5) {
      return NextResponse.json({ error: "Rating must be 1-5" }, { status: 400 })
    }
    if (review_text.trim().length < 10) {
      return NextResponse.json({ error: "Review too short — minimum 10 characters" }, { status: 400 })
    }

    // Check if wallet already reviewed this project
    const existing = await pool.query(
      `SELECT id FROM reviews WHERE project_id = $1 AND wallet = $2`,
      [project_id, wallet.toLowerCase()]
    )
    if (existing.rows.length > 0) {
      return NextResponse.json({ error: "You have already reviewed this project" }, { status: 400 })
    }

    // Get project contract for badge check
    const proj = await pool.query(`SELECT contract FROM projects WHERE id = $1`, [project_id])
    const contract = proj.rows[0]?.contract || null

    // Determine badge
    const badge = await getWalletBadge(wallet, contract)

    if (badge === "activity_unavailable") {
      return NextResponse.json({ error: "We couldn't verify your Arc activity right now. Please try again in a moment." }, { status: 503 })
    }
    if (badge === "unverified") {
      return NextResponse.json({ error: "You need at least one transaction on Arc testnet to leave a review. Make any transaction on Arc first." }, { status: 400 })
    }

    await pool.query(
      `INSERT INTO reviews (project_id, wallet, category, rating, review_text, is_public, contact, badge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [project_id, wallet.toLowerCase(), category, rating, review_text.trim(), is_public ?? true, contact || null, badge]
    )

    return NextResponse.json({ success: true, badge })
  } catch (err) {
    console.error("[Reviews API]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
