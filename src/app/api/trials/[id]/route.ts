import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"
import { hasAdminAuthorization } from "@/lib/adminAuth"

const pool = getPool()

// Tiered edit policy for live campaigns:
// - COSMETIC: applied instantly. Founders can fix typos, swap banners, update links
//   without waiting for admin. Low-stakes, easily reversible.
// - MATERIAL: queued in pending_campaign_updates for admin approval. Stops
//   bait-and-switch (high reward to attract testers → silently nerf after).
// - Anything not in either list is locked once the campaign exists.
const COSMETIC = new Set(["tagline", "description", "app_url", "banner_position", "campaign_logo", "reward_description", "invite_codes", "invite_codes_note"])
// `max_xp_per_completion` is material — changing the XP pool retroactively
// shifts what already-rated testers earned vs new ones.
// `tasks` and `review_questions` are material so founders can fix typos,
// rewrite for clarity, or add new steps mid-campaign — admin reviews via
// the pending_campaign_updates queue to prevent bait-and-switch.
// `xp_mode` and per-question xp_value stay fully locked — switching them
// mid-campaign would invalidate already-rated submissions.
const MATERIAL = new Set(["title", "expires_at", "total_slots", "contract_address", "max_xp_per_completion", "tasks", "review_questions"])

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(req)
  const isAdmin = hasAdminAuthorization(req)

  const isNumeric = /^\d+$/.test(id)
  const whereClause = isNumeric ? "c.id = $1" : "c.slug = $1"

  try {
    // Auto-end logic — matches /api/trials. Catches campaigns past their
    // deadline OR at capacity, stamping ended_at + ended_reason so the
    // UI can show why they ended.
    pool.query(`
      UPDATE campaigns SET
        status       = 'ended',
        ended_at     = COALESCE(
          ended_at,
          CASE
            WHEN total_slots IS NOT NULL AND filled_slots >= total_slots THEN
              COALESCE(
                (SELECT MAX(cc.created_at) FROM campaign_completions cc WHERE cc.campaign_id = campaigns.id),
                NOW()
              )
            ELSE expires_at
          END,
          NOW()
        ),
        ended_reason = COALESCE(
          ended_reason,
          CASE
            WHEN total_slots IS NOT NULL AND filled_slots >= total_slots THEN 'slots_filled'
            ELSE 'expired'
          END
        )
      WHERE status = 'active'
        AND (
          (expires_at IS NOT NULL AND expires_at < NOW())
          OR (total_slots IS NOT NULL AND filled_slots >= total_slots)
        )
    `).catch(() => {})

    const campaignRes = await pool.query(
      `SELECT
         c.*,
         p.twitter AS project_twitter,
         p.slug    AS project_slug,
         (SELECT COUNT(*) FROM campaign_completions cc WHERE cc.campaign_id = c.id) AS completion_count,
         (SELECT COUNT(*) FROM campaign_completions cc WHERE cc.campaign_id = c.id AND cc.status = 'reviewed') AS reviewed_count
       FROM campaigns c
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE ${whereClause}`,
      [isNumeric ? Number(id) : id]
    )

    if (!campaignRes.rows.length) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }

    const campaignId = campaignRes.rows[0].id
    const creatorWallet = campaignRes.rows[0].creator_wallet
    const isCreator = !!(session && creatorWallet && session.addr === String(creatorWallet).toLowerCase())
    const canReviewAll = isCreator || isAdmin

    // Auto-finalize: if a founder hasn't rated within 7 days, fall back to the
    // tester's provisional_score (derived from auto_score at submission time)
    // as the final quality_score. Also assign a default builder_rating + XP so
    // the tester appears on leaderboards and earns a fair share of XP even
    // when the founder ghosts — otherwise XP campaigns silently zero them out.
    //   builder_rating = round(provisional_score), clamped to [1,5]
    //   xp_earned      = round((provisional / 5) × campaign.max_xp_per_completion)
    pool.query(
      `UPDATE campaign_completions cc
         SET quality_score  = cc.provisional_score,
             builder_rating = GREATEST(1, LEAST(5, ROUND(cc.provisional_score)::int)),
             xp_earned      = COALESCE(
                                ROUND((cc.provisional_score / 5.0) * c.max_xp_per_completion)::int,
                                0
                              ),
             status         = 'reviewed',
             reviewed_at    = NOW()
       FROM campaigns c
       WHERE cc.campaign_id = c.id
         AND cc.campaign_id = $1
         AND cc.status      = 'submitted'
         AND cc.created_at  < NOW() - INTERVAL '7 days'
         AND cc.provisional_score IS NOT NULL`,
      [campaignId]
    ).catch(() => {})

    // NOTE: task_proofs MUST be included — the founder dashboard renders proof
    // links + screenshot thumbnails per submission. xp_earned + per_question_ratings
    // are also needed for the rating breakdown. LIMIT raised to 500 so large
    // campaigns (Tower had 56 submissions silently dropped at LIMIT 50) show
    // every tester.
    const completionsRes = await pool.query(
      canReviewAll
        ? `SELECT tester_wallet, auto_score, builder_rating, quality_score, status,
                  reward_delivered, review_answers, task_proofs, contract_verified,
                  xp_earned, per_question_ratings, created_at
             FROM campaign_completions WHERE campaign_id = $1
             ORDER BY created_at DESC LIMIT 500`
        : `SELECT tester_wallet, builder_rating, quality_score, status,
                  reward_delivered, xp_earned, created_at
             FROM campaign_completions WHERE campaign_id = $1
             ORDER BY created_at DESC LIMIT 500`,
      [campaignId],
    )

    // A signed-in tester can see their own submitted answers/proofs, but never
    // another tester's. The creator can see all submissions for moderation.
    if (!canReviewAll && session) {
      const own = await pool.query(
        `SELECT tester_wallet, auto_score, builder_rating, quality_score, status,
                reward_delivered, review_answers, task_proofs, contract_verified,
                xp_earned, per_question_ratings, created_at
           FROM campaign_completions
          WHERE campaign_id = $1 AND LOWER(tester_wallet) = $2
          LIMIT 1`,
        [campaignId, session.addr],
      )
      if (own.rows[0]) {
        const index = completionsRes.rows.findIndex(r => String(r.tester_wallet).toLowerCase() === session.addr)
        if (index >= 0) completionsRes.rows[index] = own.rows[0]
      }
    }

    // Return the most recent pending or rejected edit request to the creator
    let pendingUpdate = null
    if (isCreator) {
      try {
        const upd = await pool.query(
          `SELECT id, proposed_changes, status, submitted_at, admin_note
           FROM pending_campaign_updates
           WHERE campaign_id = $1 AND requester_wallet = $2 AND status IN ('pending','rejected')
           ORDER BY submitted_at DESC LIMIT 1`,
          [campaignId, session!.addr]
        )
        if (upd.rows.length > 0) pendingUpdate = upd.rows[0]
      } catch { }
    }

    const campaign = { ...campaignRes.rows[0] }
    if (!session && !isAdmin) {
      delete campaign.invite_codes
      delete campaign.invite_codes_note
    }
    if (!canReviewAll) {
      delete campaign.deposit_tx_hash
      delete campaign.rejection_reason
      delete campaign.admin_note
    }

    return NextResponse.json({
      campaign,
      completions: completionsRes.rows,
      pendingUpdate,
    }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

// PUT — founder submits a campaign edit. Cosmetic edits apply instantly,
// material edits queue for admin approval, everything else is rejected.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = await enforce(req, "campaign-edit", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  const { id } = await params
  try {
    const { creator_wallet, changes } = await req.json()
    if (!creator_wallet || !changes || typeof changes !== "object") {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 })
    }
    const wallet = String(creator_wallet).toLowerCase()

    // Session must match the wallet making the edit — same one-sign-in pattern
    // used by every other founder action on the platform.
    const sess = getSession(req)
    if (!sess || sess.addr !== wallet) {
      return NextResponse.json({ error: "Sign in with the campaign creator wallet to edit" }, { status: 401 })
    }

    const isNumeric = /^\d+$/.test(id)
    const campaign = await pool.query(
      `SELECT id, title, filled_slots FROM campaigns WHERE ${isNumeric ? "id = $1" : "slug = $1"} AND creator_wallet = $2`,
      [isNumeric ? Number(id) : id, wallet]
    )
    if (!campaign.rows.length) return NextResponse.json({ error: "Campaign not found or not authorized" }, { status: 403 })
    const c = campaign.rows[0]

    // Split incoming changes by tier
    const cosmetic: Record<string, any> = {}
    const material: Record<string, any> = {}
    const rejected: string[] = []
    for (const [key, rawVal] of Object.entries(changes)) {
      if (rawVal === undefined || rawVal === "") continue
      if (COSMETIC.has(key))       cosmetic[key] = rawVal
      else if (MATERIAL.has(key))  material[key] = rawVal
      else                          rejected.push(key)
    }
    if (rejected.length) {
      return NextResponse.json(
        { error: `These fields are locked once a campaign exists: ${rejected.join(", ")}. Contact support if you need them changed.` },
        { status: 400 }
      )
    }
    if (!Object.keys(cosmetic).length && !Object.keys(material).length) {
      return NextResponse.json({ error: "No valid changes submitted" }, { status: 400 })
    }

    // Validate material changes (the ones that affect tester economics)
    if (material.total_slots !== undefined) {
      const n = parseInt(String(material.total_slots))
      if (isNaN(n) || n < 1) return NextResponse.json({ error: "Invalid slot count" }, { status: 400 })
      if (n < c.filled_slots) return NextResponse.json({ error: `Slot count cannot be below current filled count (${c.filled_slots})` }, { status: 400 })
    }
    if (material.contract_address !== undefined) {
      const addr = String(material.contract_address).trim()
      if (addr && !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        return NextResponse.json({ error: "Contract address must be a valid 0x address" }, { status: 400 })
      }
      material.contract_address = addr || null
    }
    if (material.max_xp_per_completion !== undefined) {
      const n = parseInt(String(material.max_xp_per_completion))
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return NextResponse.json({ error: "max_xp_per_completion must be 1 - 10000" }, { status: 400 })
      }
      material.max_xp_per_completion = n
    }
    if (material.title !== undefined) {
      const t = String(material.title).trim().slice(0, 80)
      if (!t) return NextResponse.json({ error: "Title can't be empty" }, { status: 400 })
      material.title = t
    }

    // Validate + sanitize tasks array. Founders can edit existing tasks, add
    // new ones, or remove. Admin reviews via the queue. We enforce structure
    // here so a malformed payload never reaches the admin reviewer.
    const ALLOWED_PROOF = new Set(["none", "x_link", "tx_hash", "url", "screenshot"])
    if (material.tasks !== undefined) {
      if (!Array.isArray(material.tasks) || material.tasks.length === 0) {
        return NextResponse.json({ error: "Tasks must be a non-empty array" }, { status: 400 })
      }
      if (material.tasks.length > 50) {
        return NextResponse.json({ error: "Max 50 tasks per campaign" }, { status: 400 })
      }
      const seenIds = new Set<string>()
      const cleanedTasks: any[] = []
      for (const t of material.tasks) {
        if (!t || typeof t !== "object") {
          return NextResponse.json({ error: "Each task must be an object" }, { status: 400 })
        }
        const id    = String((t as any).id || "").trim().slice(0, 32)
        const title = String((t as any).title || "").trim().slice(0, 160)
        const desc  = String((t as any).description || "").trim().slice(0, 600)
        if (!id || !title) {
          return NextResponse.json({ error: "Each task needs an id and a title" }, { status: 400 })
        }
        if (seenIds.has(id)) {
          return NextResponse.json({ error: `Duplicate task id "${id}"` }, { status: 400 })
        }
        seenIds.add(id)
        // Pass-through fields we know are safe; reject unknown keys
        const proofTypeRaw = String((t as any).proof_type || "none")
        const proofType    = ALLOWED_PROOF.has(proofTypeRaw) ? proofTypeRaw : "none"
        const contractRaw  = String((t as any).contract_address || "").trim()
        const contract     = contractRaw && /^0x[a-fA-F0-9]{40}$/.test(contractRaw) ? contractRaw : null
        cleanedTasks.push({
          id, title, description: desc,
          proof_type: proofType,
          ...(contract ? { contract_address: contract } : {}),
        })
      }
      material.tasks = JSON.stringify(cleanedTasks)
    }

    // Validate + sanitize review_questions. Same shape as tasks, with xp_value
    // forbidden in edits (only set at campaign create — changing weights mid-
    // campaign would invalidate already-rated submissions). Strip if present.
    if (material.review_questions !== undefined) {
      if (!Array.isArray(material.review_questions) || material.review_questions.length === 0) {
        return NextResponse.json({ error: "Review questions must be a non-empty array" }, { status: 400 })
      }
      if (material.review_questions.length > 20) {
        return NextResponse.json({ error: "Max 20 review questions per campaign" }, { status: 400 })
      }
      const seenQIds = new Set<string>()
      const cleanedQs: any[] = []
      for (const q of material.review_questions) {
        if (!q || typeof q !== "object") {
          return NextResponse.json({ error: "Each question must be an object" }, { status: 400 })
        }
        const id          = String((q as any).id || "").trim().slice(0, 32)
        const label       = String((q as any).label || "").trim().slice(0, 200)
        const placeholder = String((q as any).placeholder || "").trim().slice(0, 200)
        if (!id || !label) {
          return NextResponse.json({ error: "Each question needs an id and a label" }, { status: 400 })
        }
        if (seenQIds.has(id)) {
          return NextResponse.json({ error: `Duplicate question id "${id}"` }, { status: 400 })
        }
        seenQIds.add(id)
        const minWords = Math.max(0, Math.min(500, parseInt(String((q as any).min_words)) || 20))
        const required = (q as any).required !== false
        cleanedQs.push({ id, label, placeholder, min_words: minWords, required })
      }
      material.review_questions = JSON.stringify(cleanedQs)
    }

    // Trim and length-cap invite_codes_note. Empty string clears the note.
    if (cosmetic.invite_codes_note !== undefined) {
      const s = typeof cosmetic.invite_codes_note === "string" ? cosmetic.invite_codes_note.trim().slice(0, 500) : ""
      cosmetic.invite_codes_note = s || null
    }

    // Normalize invite_codes — dedupe case-insensitively, trim, cap.
    if (cosmetic.invite_codes !== undefined) {
      const raw = Array.isArray(cosmetic.invite_codes) ? cosmetic.invite_codes : []
      const seen = new Set<string>()
      const out: string[] = []
      for (const v of raw) {
        if (typeof v !== "string") continue
        const trimmed = v.trim().slice(0, 64)
        if (!trimmed) continue
        const key = trimmed.toUpperCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(trimmed)
        if (out.length >= 200) break
      }
      cosmetic.invite_codes = JSON.stringify(out)
    }

    // Apply cosmetic changes immediately. Build the SET clause dynamically but
    // safely — keys are constrained to COSMETIC, so no SQL injection surface.
    let appliedCount = 0
    if (Object.keys(cosmetic).length) {
      const keys   = Object.keys(cosmetic)
      const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(", ")
      const vals   = keys.map(k => cosmetic[k])
      await pool.query(`UPDATE campaigns SET ${setSql} WHERE id = $1`, [c.id, ...vals])
      appliedCount = keys.length
    }

    // Queue material changes for admin review
    let queuedCount = 0
    if (Object.keys(material).length) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS pending_campaign_updates (
          id SERIAL PRIMARY KEY,
          campaign_id INT NOT NULL,
          campaign_title TEXT,
          requester_wallet TEXT NOT NULL,
          proposed_changes JSONB NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          submitted_at TIMESTAMPTZ DEFAULT NOW(),
          admin_note TEXT
        )
      `)
      await pool.query(
        `INSERT INTO pending_campaign_updates (campaign_id, campaign_title, requester_wallet, proposed_changes) VALUES ($1, $2, $3, $4)`,
        [c.id, c.title, wallet, JSON.stringify(material)]
      )
      queuedCount = Object.keys(material).length
    }

    return NextResponse.json({
      success:        true,
      appliedInstant: appliedCount,
      queuedForAdmin: queuedCount,
      message:
        queuedCount > 0 && appliedCount > 0
          ? `${appliedCount} change${appliedCount === 1 ? "" : "s"} live now, ${queuedCount} pending admin review.`
        : queuedCount > 0
          ? `${queuedCount} change${queuedCount === 1 ? "" : "s"} submitted for admin review.`
        : appliedCount === 1
          ? `1 change is live now.`
          : `${appliedCount} changes are live now.`,
    })
  } catch (err) {
    console.error("[Forge PUT]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

// PATCH — record deposit tx hash (called after builder funds USDC campaign)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const { deposit_tx_hash } = await req.json()
    if (!deposit_tx_hash) return NextResponse.json({ error: "Missing deposit transaction" }, { status: 400 })
    const session = getSession(req)
    if (!session) return NextResponse.json({ error: "Sign in with the campaign creator wallet first" }, { status: 401 })

    const result = await pool.query(
      `UPDATE campaigns SET deposit_tx_hash = $1, status = 'active'
       WHERE id = $2 AND creator_wallet = $3 AND status = 'approved'
       RETURNING id`,
      [deposit_tx_hash, id, session.addr]
    )
    if (!result.rows.length) return NextResponse.json({ error: "Campaign not found, not owned by wallet, or not awaiting funding" }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
