import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// PATCH /api/trials/tester/[wallet] — update pfp_url
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ wallet: string }> }) {
  const blocked = await enforce(req, "tester-pfp", { limit: 10, windowMs: 60_000 })
  if (blocked) return blocked

  const { wallet } = await params
  const w = wallet.toLowerCase()

  // Only the wallet owner can change their own PFP — must be signed in as them
  const sess = getSession(req)
  if (!sess || sess.addr !== w) {
    return NextResponse.json({ error: "Sign in with this wallet to update your profile" }, { status: 401 })
  }

  try {
    const { pfp_url } = await req.json()
    if (!pfp_url || typeof pfp_url !== "string") {
      return NextResponse.json({ error: "pfp_url required" }, { status: 400 })
    }
    // Cap the URL length so spam can't bloat the row
    if (pfp_url.length > 1000) {
      return NextResponse.json({ error: "pfp_url too long" }, { status: 400 })
    }
    // Upsert: create reputation row if not exists, then set pfp_url
    await pool.query(
      `INSERT INTO tester_reputation (wallet, pfp_url)
       VALUES ($1, $2)
       ON CONFLICT (wallet) DO UPDATE SET pfp_url = EXCLUDED.pfp_url`,
      [w, pfp_url]
    )
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params
  const w = wallet.toLowerCase()
  try {
    const [repRes, historyRes] = await Promise.all([
      pool.query(`SELECT * FROM tester_reputation WHERE wallet = $1`, [w]),
      pool.query(`
        SELECT
          cc.campaign_id, cc.auto_score, cc.builder_rating, cc.quality_score,
          cc.contract_verified, cc.created_at, cc.status, cc.reward_delivered,
          c.title, c.type, c.project_name, c.project_logo,
          c.reward_type, c.reward_usdc_amount
        FROM campaign_completions cc
        JOIN campaigns c ON c.id = cc.campaign_id
        WHERE cc.tester_wallet = $1
        ORDER BY cc.created_at DESC
        LIMIT 50
      `, [w]),
    ])
    return NextResponse.json({
      reputation: repRes.rows[0] || null,
      history:    historyRes.rows,
    }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
