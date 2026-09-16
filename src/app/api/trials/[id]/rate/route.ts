import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// POST /api/trials/[id]/rate — founder rates a tester's submission
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const blocked = await enforce(req, "trial-rate", { limit: 30, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const body = await req.json()
    const { tester_wallet, rating, founder_wallet, impact_credited, per_question_ratings } = body

    if (!tester_wallet || !founder_wallet) {
      return NextResponse.json({ error: "Wallets required" }, { status: 400 })
    }
    // `rating` is the single overall ★ rating for Mode A. For Mode B, it may be
    // computed below from per_question_ratings if not provided — we keep both
    // because legacy callers + reputation tracking still want the 1-5 number.
    if (rating != null && (rating < 1 || rating > 5)) {
      return NextResponse.json({ error: "Rating must be 1-5" }, { status: 400 })
    }

    // Session check FIRST — before we leak any campaign existence info.
    // Only someone signed in as the founder can submit ratings as them.
    const sess = getSession(req)
    if (!sess || sess.addr !== founder_wallet.toLowerCase()) {
      return NextResponse.json({ error: "Sign in with the founder wallet to rate testers" }, { status: 401 })
    }

    // Resolve slug or numeric id → numeric campaign id. Also fetch XP config
    // so we can compute xp_earned correctly for whichever mode this campaign is in.
    const isNumeric = /^\d+$/.test(id)
    const campaignRes = await pool.query(
      `SELECT id, creator_wallet, max_xp_per_completion, xp_mode, review_questions
         FROM campaigns WHERE ${isNumeric ? "id = $1" : "slug = $1"}`,
      [isNumeric ? Number(id) : id]
    )
    if (!campaignRes.rows.length) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }
    if (campaignRes.rows[0].creator_wallet !== founder_wallet.toLowerCase()) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }
    const campaignId: number = campaignRes.rows[0].id
    const maxXp:      number | null = campaignRes.rows[0].max_xp_per_completion
    const xpMode:     string        = campaignRes.rows[0].xp_mode || "batch"
    const reviewQs:   Array<{ id: string; xp_value?: number }> = campaignRes.rows[0].review_questions || []

    // Get existing completion — fetch provisional_score so we can replace it accurately
    const compRes = await pool.query(
      `SELECT id, auto_score, provisional_score, builder_rating
       FROM campaign_completions
       WHERE campaign_id = $1 AND tester_wallet = $2`,
      [campaignId, tester_wallet.toLowerCase()]
    )
    if (!compRes.rows.length) {
      return NextResponse.json({ error: "Completion not found" }, { status: 404 })
    }

    const { auto_score, provisional_score, builder_rating: already_rated } = compRes.rows[0]
    if (already_rated != null) {
      return NextResponse.json({ error: "Already rated" }, { status: 409 })
    }

    // ── Mode A vs Mode B branching ─────────────────────────────────────────
    // Mode A (batch): single ★1-5 rating drives everything.
    // Mode B (per_question): founder rated each Q. Overall rating = avg of per-Q,
    // xp_earned = sum across questions of (q_rating/5) × q.xp_value.
    let effectiveRating: number
    let xpEarned: number = 0
    let perQRatings: Record<string, number> | null = null

    if (xpMode === "per_question" && maxXp != null) {
      // Mode B: must include per_question_ratings keyed by review_question id.
      if (!per_question_ratings || typeof per_question_ratings !== "object") {
        return NextResponse.json({ error: "per_question_ratings required for this campaign" }, { status: 400 })
      }
      perQRatings = {}
      let xpSum = 0
      let ratingSum = 0
      let ratingCount = 0
      for (const q of reviewQs) {
        const r = Number(per_question_ratings[q.id])
        if (!Number.isFinite(r) || r < 1 || r > 5) {
          return NextResponse.json({ error: `Rating for "${q.id}" must be 1-5` }, { status: 400 })
        }
        perQRatings[q.id] = Math.round(r)
        const xpVal = Number(q.xp_value) || 0
        xpSum    += (r / 5) * xpVal
        ratingSum += r
        ratingCount++
      }
      xpEarned        = Math.round(xpSum)
      effectiveRating = ratingCount > 0 ? Math.round(ratingSum / ratingCount) : 3
    } else {
      // Mode A (or campaign with no XP at all): single overall ★ rating.
      if (rating == null) {
        return NextResponse.json({ error: "Rating required" }, { status: 400 })
      }
      effectiveRating = rating
      if (maxXp != null) xpEarned = Math.round((rating / 5) * maxXp)
    }

    // Final quality_score: 60% auto + 40% builder rating (both on 0-5 scale).
    // Same math for both modes — quality_score remains the universal metric
    // (XP is project-scoped, quality_score is platform-scoped).
    const quality_score = Math.round(
      ((auto_score / 100) * 5 * 0.6 + (effectiveRating / 5) * 5 * 0.4) * 100
    ) / 100

    await pool.query(
      `UPDATE campaign_completions
       SET builder_rating         = $1,
           quality_score          = $2,
           xp_earned              = $3,
           per_question_ratings   = $4::jsonb,
           status                 = 'reviewed',
           reviewed_at            = NOW()
       WHERE campaign_id = $5 AND tester_wallet = $6`,
      [
        effectiveRating,
        quality_score,
        xpEarned,
        JSON.stringify(perQRatings || {}),
        campaignId,
        tester_wallet.toLowerCase(),
      ]
    )

    // Replace the provisional score with the real quality_score in reputation.
    // provisional_score is what was added at submission time — subtract it, add quality_score.
    const prevScore = Number(provisional_score ?? (auto_score / 100) * 5)
    const wallet = tester_wallet.toLowerCase()
    await pool.query(
      `UPDATE tester_reputation SET
         total_score  = GREATEST(0, total_score - $1 + $2),
         avg_score    = ROUND(GREATEST(0, total_score - $1 + $2) / NULLIF(campaigns_completed, 0), 2),
         impact_count = impact_count + $3,
         -- Rank ladder (lowered for an early platform — most testers are still
         -- at Scout while the campaign pool grows). Adjusted top: 50→40, and
         -- second-to-top: 25→30 to make the ceiling reachable.
         rank = CASE
           WHEN rank = 3
             AND campaigns_completed >= 40
             AND ROUND(GREATEST(0, total_score - $1 + $2) / NULLIF(campaigns_completed, 0), 2) >= 4.5
             THEN 4
           WHEN rank = 2
             AND campaigns_completed >= 30
             AND ROUND(GREATEST(0, total_score - $1 + $2) / NULLIF(campaigns_completed, 0), 2) >= 4.0
             THEN 3
           WHEN rank = 1
             AND campaigns_completed >= 10
             AND ROUND(GREATEST(0, total_score - $1 + $2) / NULLIF(campaigns_completed, 0), 2) >= 3.5
             THEN 2
           WHEN rank = 0
             AND campaigns_completed >= 3
             AND ROUND(GREATEST(0, total_score - $1 + $2) / NULLIF(campaigns_completed, 0), 2) >= 3.0
             THEN 1
           ELSE rank
         END,
         updated_at   = NOW()
       WHERE wallet = $4`,
      [prevScore, quality_score, impact_credited ? 1 : 0, wallet]
    )

    return NextResponse.json({ success: true, quality_score, xp_earned: xpEarned, rating: effectiveRating })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
