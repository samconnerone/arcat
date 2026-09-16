import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const RANK_LABELS = ["Scout", "Builder", "Verified", "Trusted", "Arc Proven"]

const RANK_NEXT: Record<number, { campaigns: number; score: number } | null> = {
  0: { campaigns: 3,  score: 3.0 },
  1: { campaigns: 10, score: 3.5 },
  2: { campaigns: 30, score: 4.0 },
  3: { campaigns: 40, score: 4.5 },
  4: null,
}

// GET /api/trials/reputation?wallet=0x...
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet) return NextResponse.json({ error: "Wallet required" }, { status: 400 })

  try {
    const [repRes, histRes] = await Promise.all([
      pool.query(
        `SELECT * FROM tester_reputation WHERE wallet = $1`,
        [wallet.toLowerCase()]
      ),
      pool.query(
        `SELECT cc.campaign_id, c.title, c.type, c.reward_type, c.project_name,
                cc.quality_score, cc.auto_score, cc.builder_rating, cc.status, cc.created_at
         FROM campaign_completions cc
         JOIN campaigns c ON c.id = cc.campaign_id
         WHERE cc.tester_wallet = $1
         ORDER BY cc.created_at DESC
         LIMIT 20`,
        [wallet.toLowerCase()]
      ),
    ])

    const rep  = repRes.rows[0] || null
    const rank = rep?.rank ?? 0
    const next = RANK_NEXT[rank]

    return NextResponse.json({
      reputation: rep
        ? {
            ...rep,
            rank_label: RANK_LABELS[rank] || "Scout",
            next_rank:  next
              ? {
                  label:             RANK_LABELS[rank + 1],
                  campaigns_needed:  Math.max(0, next.campaigns - (rep.campaigns_completed || 0)),
                  score_needed:      Math.max(0, next.score - (rep.avg_score || 0)),
                }
              : null,
          }
        : null,
      history: histRes.rows,
    })
  } catch {
    return NextResponse.json({ reputation: null, history: [] })
  }
}
