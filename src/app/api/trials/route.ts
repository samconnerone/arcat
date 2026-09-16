import { NextRequest, NextResponse, after } from "next/server"
import { scanUrl } from "@/lib/urlScan"
import { rateLimit, getIp } from "@/lib/ratelimit"
import { getPool } from "@/lib/dbPool"
import { matchesDefaultTemplate } from "@/lib/campaignTypes"
import { getSession } from "@/lib/session"

const pool = getPool()

// GET /api/trials — list active campaigns + stats
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type    = searchParams.get("type")    || ""
  const wallet  = searchParams.get("wallet")  || ""
  const creator = searchParams.get("creator") || ""
  const status  = searchParams.get("status")  || "active"

  try {
    const session = getSession(req)
    if (creator && (!session || session.addr !== creator.toLowerCase())) {
      return NextResponse.json({ error: "Sign in with the creator wallet first" }, { status: 401 })
    }
    // Expire campaigns past their deadline OR at-capacity — fire and forget,
    // never blocks the response. Also stamps ended_at/ended_reason so the UI
    // can show "Ended on X (slots filled)" instead of just "active forever".
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

    const conditions: string[] = []
    const params: unknown[]    = []

    // Creator view shows all their campaigns regardless of status
    if (creator) {
      params.push(creator.toLowerCase())
      conditions.push(`c.creator_wallet = $${params.length}`)
    } else {
      params.push(status === "ended" ? "ended" : "active")
      conditions.push(`c.status = $${params.length}`)
    }

    if (type && type !== "all") {
      params.push(type)
      conditions.push(`c.type = $${params.length}`)
    }

    const where = conditions.join(" AND ")

    const [campaignsRes, statsRes, repRes] = await Promise.all([
      pool.query(
        `SELECT
           c.id, c.slug, c.title, c.tagline, c.type, c.reward_type, c.reward_description,
           c.reward_usdc_amount, c.contract_address,
           c.total_slots, c.filled_slots, c.is_fcfs, c.min_rank,
           c.project_name, c.project_logo, c.campaign_logo, c.creator_wallet,
           c.tasks, c.created_at, c.expires_at, c.status, c.rejection_reason, c.app_url,
           c.ended_at, c.ended_reason,
           (SELECT COUNT(*) FROM campaign_completions cc WHERE cc.campaign_id = c.id) AS completion_count
         FROM campaigns c
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT 100`,
        params
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM campaigns WHERE status = 'active')          AS active_campaigns,
           (SELECT COUNT(*) FROM tester_reputation)                          AS total_testers,
           (SELECT COUNT(*) FROM campaign_completions WHERE status != 'flagged') AS total_completions,
           (SELECT COUNT(*) FROM campaign_completions
            WHERE created_at > NOW() - INTERVAL '7 days')                   AS completions_this_week`
      ),
      wallet
        ? pool.query(
            `SELECT rank, rank_points, campaigns_completed, avg_score, impact_count
             FROM tester_reputation WHERE wallet = $1`,
            [wallet.toLowerCase()]
          )
        : Promise.resolve({ rows: [] }),
    ])

    return NextResponse.json({
      campaigns:  campaignsRes.rows,
      stats:      statsRes.rows[0],
      reputation: repRes.rows[0] || null,
    }, {
      headers: { "Cache-Control": creator ? "no-store" : "public, s-maxage=30, stale-while-revalidate=60" },
    })
  } catch {
    return NextResponse.json({ campaigns: [], stats: null, reputation: null })
  }
}

// POST /api/trials — create campaign
export async function POST(req: NextRequest) {
  // Rate limit: 5 campaigns per hour per IP
  const rl = await rateLimit(`forge-create:${getIp(req)}`, 5, 3_600_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many campaigns created. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    )
  }

  try {
    const session = getSession(req)
    if (!session) return NextResponse.json({ error: "Sign in with your wallet first" }, { status: 401 })
    const creator_wallet = session.addr
    const body = await req.json()
    const {
      title, tagline, description, type,
      tasks, review_questions,
      reward_type, reward_description, reward_usdc_amount,
      deposit_tx_hash,
      contract_address,
      campaign_logo,
      banner_position,
      app_url,
      total_slots, is_fcfs, min_rank,
      project_id,
      expires_at,
      invite_codes, invite_codes_note,
      max_xp_per_completion, xp_mode,
    } = body

    if (!title?.trim())         return NextResponse.json({ error: "Title required" }, { status: 400 })
    if (!description?.trim())   return NextResponse.json({ error: "Description required" }, { status: 400 })
    if (!tasks?.length)         return NextResponse.json({ error: "At least one task required" }, { status: 400 })
    if (!review_questions?.length) return NextResponse.json({ error: "At least one review question required" }, { status: 400 })

    // Reject any type's untouched starter template — steps like "Complete the
    // core action" give testers nothing to act on and admins nothing to review.
    // Type-aware (shared with the create form) so it covers every campaign type,
    // not just beta. Guards direct API submissions that bypass the form.
    if (matchesDefaultTemplate(String(type || ""), tasks as { title?: string }[])) {
      return NextResponse.json({ error: "Steps are still the untouched template — describe the actual actions testers should take in your app" }, { status: 400 })
    }

    // A dedicated campaign banner is required — without one the campaign page
    // stretches the project logo, which reads as unfinished to testers.
    if (!campaign_logo || typeof campaign_logo !== "string" || !campaign_logo.trim()) {
      return NextResponse.json({ error: "A campaign banner is required — upload custom 16:9 art for this campaign" }, { status: 400 })
    }

    // ── XP validation ────────────────────────────────────────────────────────
    // Tower's project-specific XP system. Two opt-in modes:
    //   batch (Mode A, default):  founder rates ★1-5 once, XP = (rating/5) × max_xp.
    //   per_question (Mode B):    founder rates each Q ★1-5, XP per Q = (rating/5) × xp_value.
    // Both are opt-in — leave max_xp_per_completion null and campaigns rank by
    // quality_score the same as before.
    const wantsXp     = max_xp_per_completion != null && max_xp_per_completion !== ""
    const xpMode      = wantsXp ? (xp_mode === "per_question" ? "per_question" : "batch") : "batch"
    let   xpMax: number | null = null

    if (wantsXp) {
      const n = parseInt(String(max_xp_per_completion))
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return NextResponse.json({ error: "max_xp_per_completion must be between 1 and 10000" }, { status: 400 })
      }
      xpMax = n

      // Mode B: every question must have an xp_value, and the sum must equal max_xp
      // (no implicit weighting — founder is explicit so we don't surprise testers).
      if (xpMode === "per_question") {
        const values: number[] = []
        for (const q of review_questions) {
          const v = Number(q?.xp_value)
          if (!Number.isFinite(v) || v < 0 || v > 10000) {
            return NextResponse.json({ error: "Each question needs an xp_value between 0 and 10000 in per-question mode" }, { status: 400 })
          }
          values.push(Math.floor(v))
          q.xp_value = Math.floor(v)
        }
        const sum = values.reduce((s, n) => s + n, 0)
        if (sum !== xpMax) {
          return NextResponse.json({ error: `Per-question XP values must sum to ${xpMax} (currently ${sum})` }, { status: 400 })
        }
      }
    }

    // Gate: creator must have at least one approved and live project on Arc Ecosystem
    const projGate = await pool.query(
      `SELECT id FROM projects WHERE owner_wallet = $1 AND approved = true AND live = true LIMIT 1`,
      [creator_wallet.toLowerCase()]
    )
    if (!projGate.rows.length) {
      return NextResponse.json({ error: "You must have an approved project on Arc Ecosystem before creating a campaign" }, { status: 403 })
    }

    // Verify wallet owns the linked project if project_id is provided
    let project_name: string | null = null
    let project_logo: string | null = null

    if (project_id) {
      const proj = await pool.query(
        `SELECT name, logo_url, owner_wallet FROM projects WHERE id = $1 AND approved = true`,
        [project_id]
      )
      if (!proj.rows.length) return NextResponse.json({ error: "Project not found" }, { status: 404 })
      if (proj.rows[0].owner_wallet?.toLowerCase() !== creator_wallet.toLowerCase()) {
        return NextResponse.json({ error: "Wallet does not own this project" }, { status: 403 })
      }
      project_name = proj.rows[0].name
      project_logo = proj.rows[0].logo_url
    }

    // Generate URL slug from title — lowercase, alphanumeric + hyphens
    const baseSlug = title.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80)

    // Handle slug collisions with a numeric suffix
    let slug = baseSlug
    let suffix = 1
    while (true) {
      const existing = await pool.query(`SELECT id FROM campaigns WHERE slug = $1`, [slug])
      if (!existing.rows.length) break
      slug = `${baseSlug}-${++suffix}`
    }

    // Sanitize per-task `proof_type` — used for verification campaigns (Tower's
    // aggregator-DEX flow where on-chain contract verification doesn't apply,
    // so the founder asks for X links / tx hashes / generic URLs as evidence).
    //
    // Enum: "none" | "x_link" | "tx_hash" | "url"
    const ALLOWED_PROOF = new Set(["none", "x_link", "tx_hash", "url", "screenshot"])
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        if (t && typeof t === "object") {
          const pt = typeof t.proof_type === "string" ? t.proof_type : "none"
          t.proof_type = ALLOWED_PROOF.has(pt) ? pt : "none"
        }
      }
    }

    // Normalize invite codes — trim, cap length, dedupe case-insensitively.
    // Arcat stores them verbatim and displays to testers; we don't validate
    // or enforce usage (Tower's DEX handles redemption).
    const normalizedCodes: string[] = []
    if (Array.isArray(invite_codes) && invite_codes.length > 0) {
      const seen = new Set<string>()
      for (const raw of invite_codes) {
        if (typeof raw !== "string") continue
        const c = raw.trim().slice(0, 64)
        if (!c) continue
        const key = c.toUpperCase()
        if (seen.has(key)) continue
        seen.add(key)
        normalizedCodes.push(c)
        if (normalizedCodes.length >= 200) break
      }
    }

    const result = await pool.query(
      `INSERT INTO campaigns
         (title, tagline, description, type,
          tasks, review_questions,
          reward_type, reward_description, reward_usdc_amount,
          deposit_tx_hash, contract_address,
          campaign_logo, banner_position, app_url, slug,
          total_slots, is_fcfs, min_rank,
          project_id, project_name, project_logo,
          creator_wallet, expires_at, invite_codes, invite_codes_note,
          max_xp_per_completion, xp_mode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'pending_approval')
       RETURNING id, slug`,
      [
        title.trim(),
        tagline?.trim() || null,
        description.trim(),
        type || "beta_test",
        JSON.stringify(tasks),
        JSON.stringify(review_questions),
        reward_type || "other",
        reward_description?.trim() || null,
        reward_usdc_amount ? Number(reward_usdc_amount) : null,
        deposit_tx_hash || null,
        contract_address?.trim() || null,
        campaign_logo?.trim() || null,
        banner_position?.trim() || "50% 50%",
        app_url?.trim() || null,
        slug,
        total_slots ? Number(total_slots) : null,
        is_fcfs !== false,
        Number(min_rank) || 0,
        project_id || null,
        project_name,
        project_logo,
        creator_wallet.toLowerCase(),
        expires_at || null,
        JSON.stringify(normalizedCodes),
        typeof invite_codes_note === "string" ? invite_codes_note.trim().slice(0, 500) || null : null,
        xpMax,
        xpMode,
      ]
    )

    // Reputation-scan the campaign's app URL (VirusTotal) after responding —
    // the verdict shows in the admin review dossier before approval.
    if (app_url?.trim()) after(() => scanUrl(app_url))
    return NextResponse.json({ success: true, id: result.rows[0].id, slug: result.rows[0].slug })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
