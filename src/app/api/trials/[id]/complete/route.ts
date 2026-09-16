import { NextRequest, NextResponse } from "next/server"
import { getProvider } from "@/lib/arc"
import { rateLimit, getIp } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// Ensure unique constraint exists — safe to run on every cold start
pool.query("CREATE UNIQUE INDEX IF NOT EXISTS tester_reputation_wallet_unique ON tester_reputation (wallet)").catch(() => {})

// Check if a wallet has interacted with any of the provided contracts via Arc RPC event logs.
// Checks campaign-level + per-task contract addresses in parallel.
// Any event emitted by a contract that includes the tester wallet as a topic = verified.
async function checkContractVerification(
  contractAddresses: string[],
  testerWallet: string
): Promise<boolean | null> {
  // Deduplicate and filter valid addresses
  const unique = [...new Set(
    contractAddresses.filter(a => a && /^0x[a-fA-F0-9]{40}$/i.test(a))
  )]
  if (!unique.length) return null

  try {
    const provider   = getProvider()
    const latest     = await provider.getBlockNumber()
    const fromBlock  = Math.max(0, latest - 200000)
    // Wallet address padded to 32 bytes — standard ABI topic encoding for address params
    const paddedAddr = `0x000000000000000000000000${testerWallet.replace("0x", "").toLowerCase()}`

    // Check all contracts in parallel — verified if tester wallet appears in any
    const results = await Promise.all(
      unique.map(address =>
        provider.getLogs({ address, fromBlock, toBlock: "latest" })
          .then(logs => logs.some(log =>
            log.topics.some(topic => topic.toLowerCase() === paddedAddr)
          ))
          .catch(() => false)
      )
    )

    return results.some(Boolean)
  } catch (e) {
    console.error("[arc-verify]", e)
    return null  // RPC error — don't penalise tester, allow submission unverified
  }
}

// Count meaningful unique words (>3 chars) to prevent word-stuffing / repetition gaming.
// A tester writing "great great great great" 50 times gets credit for 1 word, not 50.
function meaningfulUniqueWords(text: string): number {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const unique = new Set(words.filter(w => w.length > 3))
  // Also penalise if total words far exceed unique words (copy-paste / repetition signal)
  const total  = words.length
  const ratio  = total > 0 ? unique.size / total : 0
  // If less than 40% unique words the answer is heavily repetitive — halve the unique count
  return ratio < 0.4 ? Math.floor(unique.size * 0.5) : unique.size
}

// Compute an automatic quality score 0-100.
// Scoring is based on unique meaningful word count, not raw word count.
// contract_verified adds a 10-point bonus — rewarding testers who actually go on-chain.
function computeAutoScore(
  _tasks: unknown,
  review_questions: { id: string; min_words: number; required: boolean }[],
  _tx_hashes: unknown,
  review_answers: Record<string, string>,
  contract_verified?: boolean | null
): number {
  let score = 0

  const requiredQs = review_questions.filter(q => q.required)
  if (requiredQs.length > 0) {
    const ptsEach = 90 / requiredQs.length  // 90 pts max from answers, 10 reserved for on-chain bonus
    for (const q of requiredQs) {
      const uWords = meaningfulUniqueWords(review_answers[q.id] || "")
      const min    = Math.ceil((q.min_words || 20) * 0.6)  // unique-word target = 60% of min_words
      if (uWords >= min * 2)      score += ptsEach          // thorough: 2× unique target
      else if (uWords >= min)     score += ptsEach * 0.7    // solid: met unique target
      else if (uWords >= min / 2) score += ptsEach * 0.35   // thin: half target
      // below half: 0 — not acceptable
    }
  } else {
    const totalUnique = meaningfulUniqueWords(Object.values(review_answers).join(" "))
    score = Math.min(90, totalUnique * 3)
  }

  // On-chain verification bonus — tester actually interacted with the contract
  if (contract_verified === true) score += 10

  return Math.min(100, Math.round(score))
}

// POST /api/trials/[id]/complete — tester submits campaign completion
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Loose per-IP cap — anti-DDOS only, NOT a personal limit. The real
  // participation cap is the unique (campaign_id, tester_wallet) constraint:
  // one wallet can only successfully submit once per campaign, so we don't
  // rate-limit individuals at all. The IP cap exists solely to stop mass-bot
  // floods. Set high (300/hr ≈ 5/min) because many testers legitimately share
  // an IP (mobile carriers, university WiFi, corporate NAT, VPNs) — the old
  // 10/hr/IP crushed everyone behind shared NAT when one tester retried.
  const rl = await rateLimit(`complete:${getIp(req)}`, 300, 3_600_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many submissions from your network right now. Try a different connection or wait a few minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    )
  }

  try {
    const body = await req.json()
    const { tester_wallet, tx_hashes = [], review_answers = {}, task_proofs = {} } = body

    if (!tester_wallet?.trim()) {
      return NextResponse.json({ error: "Wallet required" }, { status: 400 })
    }

    const wallet = tester_wallet.toLowerCase()

    // Session check: only the actual tester can submit their own completion.
    // Without this anyone could spoof completions to inflate (or trash) a
    // wallet's reputation and block legitimate users via the duplicate check.
    const sess = getSession(req)
    if (!sess || sess.addr !== wallet) {
      return NextResponse.json({ error: "Sign in with the tester wallet to submit this completion" }, { status: 401 })
    }

    // Resolve slug or numeric id
    const isNumeric = /^\d+$/.test(id)
    const campaignRes = await pool.query(
      `SELECT id, status, total_slots, filled_slots, tasks, review_questions, min_rank, contract_address
       FROM campaigns WHERE ${isNumeric ? "id = $1" : "slug = $1"}`,
      [isNumeric ? Number(id) : id]
    )
    if (!campaignRes.rows.length) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    }
    const campaign = campaignRes.rows[0]

    if (campaign.status !== "active") {
      return NextResponse.json({ error: "Campaign is not active" }, { status: 400 })
    }
    if (campaign.total_slots && campaign.filled_slots >= campaign.total_slots) {
      return NextResponse.json({ error: "Campaign is full" }, { status: 400 })
    }
    // Note: final atomic slot claim happens after insert (see below) to prevent race conditions

    // Check tester rank requirement
    if (campaign.min_rank > 0) {
      const repRes = await pool.query(
        `SELECT rank FROM tester_reputation WHERE wallet = $1`,
        [wallet]
      )
      const rank = repRes.rows[0]?.rank ?? 0
      if (rank < campaign.min_rank) {
        return NextResponse.json({ error: "Your rank does not meet the campaign requirement" }, { status: 403 })
      }
    }

    const campaignNumericId: number = campaign.id

    // Check for duplicate
    const dupCheck = await pool.query(
      `SELECT id FROM campaign_completions WHERE campaign_id = $1 AND tester_wallet = $2`,
      [campaignNumericId, wallet]
    )
    if (dupCheck.rows.length) {
      return NextResponse.json({ error: "You have already submitted this campaign" }, { status: 409 })
    }

    // Validate task proofs — for any task whose proof_type isn't "none", the
    // tester must submit a proof and it must match the expected format. This
    // is Tower-style verification: the founder asked for X link / tx hash /
    // URL as evidence the tester actually used the product. We sanitize and
    // store only the verified shape.
    //
    // EXCLUSION: when the campaign has internal verification (any contract
    // address set, campaign-level or per-task), Arcat auto-checks on-chain
    // participation via Arc RPC logs above — asking the tester for ALSO a
    // manual proof would be redundant double-work. We compute hasContracts
    // again here for the clearest gating signal.
    const cleanedProofs: Record<string, string> = {}
    const taskContractsForGate: string[] = (campaign.tasks || [])
      .map((t: { contract_address?: string }) => t.contract_address || "")
      .filter(Boolean)
    const hasInternalVerification = !!campaign.contract_address || taskContractsForGate.length > 0
    const proofs = (task_proofs && typeof task_proofs === "object") ? task_proofs as Record<string, unknown> : {}
    for (const t of (campaign.tasks || []) as Array<{ id: string; proof_type?: string; title?: string }>) {
      const pt = t.proof_type || "none"
      // Internal verification handles this campaign — skip proof requirements
      // even if proof_type was set on a task (could be stale founder edit).
      if (hasInternalVerification) continue
      if (pt === "none") continue
      const raw = proofs[t.id]
      const val = typeof raw === "string" ? raw.trim() : ""
      const taskLabel = t.title || t.id
      if (!val) {
        return NextResponse.json({ error: `Proof required for step "${taskLabel}"` }, { status: 400 })
      }
      if (pt === "tx_hash") {
        if (!/^0x[a-fA-F0-9]{64}$/.test(val)) {
          return NextResponse.json({ error: `Step "${taskLabel}": tx hash must be 0x followed by 64 hex characters` }, { status: 400 })
        }
        cleanedProofs[t.id] = val.toLowerCase()
      } else if (pt === "x_link") {
        if (!/^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(val)) {
          return NextResponse.json({ error: `Step "${taskLabel}": must be a valid X / Twitter post URL` }, { status: 400 })
        }
        cleanedProofs[t.id] = val.slice(0, 500)
      } else if (pt === "url") {
        try {
          const u = new URL(val)
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad")
          cleanedProofs[t.id] = val.slice(0, 500)
        } catch {
          return NextResponse.json({ error: `Step "${taskLabel}": must be a valid http(s) URL` }, { status: 400 })
        }
      } else if (pt === "screenshot") {
        // Screenshots must come from our own /api/upload pipeline. We accept
        // Vercel Blob (primary host) and imgbb (fallback) — the only two hosts
        // our upload route produces. The whitelist blocks anyone pasting a
        // random URL straight into the field.
        try {
          const u = new URL(val)
          const ok = u.hostname === "i.ibb.co" || u.hostname === "ibb.co"
                  || u.hostname.endsWith(".ibb.co")
                  || u.hostname.endsWith(".blob.vercel-storage.com")
          if (!ok || u.protocol !== "https:") throw new Error("bad host")
          cleanedProofs[t.id] = val.slice(0, 500)
        } catch {
          return NextResponse.json({ error: `Step "${taskLabel}": upload a screenshot via the wizard (don't paste an external link)` }, { status: 400 })
        }
      }
    }

    // ── Tamper-proofing: reject reused tx hashes / X posts ────────────────────
    // A transaction hash and an X post URL are both globally unique artifacts.
    // Two testers submitting the same one (or one tester reusing another's)
    // means copy-paste fraud. We scope the uniqueness check to THIS campaign —
    // the same tx could legitimately appear across different projects' campaigns.
    // Screenshot URLs are inherently unique per upload (imgbb), so no check.
    if (!hasInternalVerification) {
      // Build the set of "uniqueness keys" the current submission introduces.
      // tx_hash → the lowercased hash. x_link → the numeric status id (so the
      // same tweet with/without ?s=20 etc. still collides).
      const xStatusId = (url: string): string | null => {
        const m = url.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)
        return m ? m[1] : null
      }
      const taskProofType: Record<string, string> = {}
      for (const t of (campaign.tasks || []) as Array<{ id: string; proof_type?: string }>) {
        taskProofType[t.id] = t.proof_type || "none"
      }

      const myKeys: { taskId: string; key: string; kind: string }[] = []
      for (const [taskId, val] of Object.entries(cleanedProofs)) {
        const pt = taskProofType[taskId]
        if (pt === "tx_hash")      myKeys.push({ taskId, key: "tx:" + val.toLowerCase(), kind: "tx" })
        else if (pt === "x_link")  { const sid = xStatusId(val); if (sid) myKeys.push({ taskId, key: "x:" + sid, kind: "x" }) }
      }

      // (a) Within-submission reuse: each distinct step demands a distinct
      // proof. Pasting one tx hash into swap + bridge + recurring-order is
      // gaming — they only did one action. Reject before touching the DB.
      const selfSeen = new Set<string>()
      for (const mk of myKeys) {
        if (selfSeen.has(mk.key)) {
          const label = mk.kind === "tx" ? "transaction hash" : "X post"
          return NextResponse.json({
            error: `You used the same ${label} for more than one step. Each step needs its own proof — complete each action separately.`,
            duplicate_proof: true,
          }, { status: 409 })
        }
        selfSeen.add(mk.key)
      }

      // (b) Cross-tester reuse: someone else already submitted this exact proof.
      if (myKeys.length > 0) {
        // Pull every prior completion's proofs for this campaign (excluding the
        // current wallet so a re-submit of one's own proof isn't blocked — the
        // dup-check above already prevents re-submission anyway).
        const prior = await pool.query(
          `SELECT task_proofs FROM campaign_completions
            WHERE campaign_id = $1 AND tester_wallet != $2`,
          [campaignNumericId, wallet]
        )
        const usedKeys = new Set<string>()
        for (const row of prior.rows) {
          const tp = row.task_proofs || {}
          for (const v of Object.values(tp as Record<string, string>)) {
            if (typeof v !== "string") continue
            if (/^0x[a-fA-F0-9]{64}$/.test(v)) usedKeys.add("tx:" + v.toLowerCase())
            const sid = xStatusId(v)
            if (sid) usedKeys.add("x:" + sid)
          }
        }
        for (const mk of myKeys) {
          if (usedKeys.has(mk.key)) {
            const label = mk.kind === "tx" ? "transaction hash" : "X post"
            return NextResponse.json({
              error: `That ${label} has already been submitted by another tester for this campaign. Each proof must be unique — submit your own.`,
              duplicate_proof: true,
            }, { status: 409 })
          }
        }
      }
    }

    // Validate at least one review answer has meaningful content
    const totalWords = Object.values(review_answers as Record<string, string>)
      .join(" ").split(/\s+/).filter(Boolean).length
    if (totalWords < 15) {
      return NextResponse.json({ error: "Please provide more detailed feedback before submitting" }, { status: 400 })
    }

    // Collect all contract addresses: campaign-level + per-task contracts
    const taskContracts: string[] = (campaign.tasks || [])
      .map((t: { contract_address?: string }) => t.contract_address || "")
      .filter(Boolean)
    const allContracts = [campaign.contract_address || "", ...taskContracts]

    // Auto-verify on-chain interaction across all contracts via Arc RPC
    let contract_verified: boolean | null = null
    const hasContracts = allContracts.some(Boolean)
    if (hasContracts) {
      contract_verified = await checkContractVerification(allContracts, wallet)
      // Hard gate — if contracts are configured and the tester hasn't interacted, block submission
      if (contract_verified === false) {
        return NextResponse.json({
          error: "On-chain participation required. Complete the contract interaction on Arc Testnet before submitting.",
          contract_required: true,
        }, { status: 403 })
      }
    }

    // Compute auto score now that we know contract_verified
    const auto_score = computeAutoScore(
      campaign.tasks        || [],
      campaign.review_questions || [],
      tx_hashes,
      review_answers,
      contract_verified
    )

    // Insert completion — store provisional_score so rate endpoint can replace it accurately
    const provisionalScore = (auto_score / 100) * 5
    await pool.query(
      `INSERT INTO campaign_completions
         (campaign_id, tester_wallet, tx_hashes, review_answers, task_proofs, auto_score, contract_verified, provisional_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [campaignNumericId, wallet, tx_hashes, JSON.stringify(review_answers), JSON.stringify(cleanedProofs), auto_score, contract_verified, provisionalScore]
    )

    // Atomic slot increment — prevents race condition when two testers submit simultaneously.
    // Also flips status to 'ended' the moment the LAST slot is filled (rather than
    // waiting for expires_at to elapse). The "filled_slots + 1 >= total_slots" check
    // captures the increment we're about to apply, so the transition is atomic with the
    // increment and there's no window where filled = total but status = 'active'.
    if (campaign.total_slots) {
      const slotRes = await pool.query(
        `UPDATE campaigns SET
           filled_slots = filled_slots + 1,
           status = CASE
             WHEN filled_slots + 1 >= total_slots THEN 'ended'
             ELSE status
           END,
           ended_at = CASE
             WHEN filled_slots + 1 >= total_slots AND ended_at IS NULL THEN NOW()
             ELSE ended_at
           END,
           ended_reason = CASE
             WHEN filled_slots + 1 >= total_slots AND ended_reason IS NULL THEN 'slots_filled'
             ELSE ended_reason
           END
         WHERE id = $1 AND filled_slots < total_slots
         RETURNING id, status, filled_slots, total_slots`,
        [campaignNumericId]
      )
      if (!slotRes.rows.length) {
        // Another tester claimed the last slot between our check and now — roll back completion
        await pool.query(`DELETE FROM campaign_completions WHERE campaign_id = $1 AND tester_wallet = $2`, [campaignNumericId, wallet])
        return NextResponse.json({ error: "Campaign is full" }, { status: 400 })
      }
    } else {
      await pool.query(`UPDATE campaigns SET filled_slots = filled_slots + 1 WHERE id = $1`, [campaignNumericId])
    }

    // Upsert reputation record (provisional — quality_score refined after builder rating)
    await pool.query(
      `INSERT INTO tester_reputation (wallet, campaigns_completed, total_score, avg_score, rank_points)
       VALUES ($1, 1, $2, $2, $3)
       ON CONFLICT (wallet) DO UPDATE SET
         campaigns_completed = tester_reputation.campaigns_completed + 1,
         total_score         = tester_reputation.total_score + $2,
         avg_score           = ROUND((tester_reputation.total_score + $2) /
                               (tester_reputation.campaigns_completed + 1), 2),
         rank_points         = tester_reputation.rank_points + $3,
         rank                = CASE
           -- Arc Proven: 40+ campaigns, avg 4.5+, currently Trusted
           WHEN tester_reputation.rank = 3
             AND (tester_reputation.campaigns_completed + 1) >= 40
             AND ROUND((tester_reputation.total_score + $2) / (tester_reputation.campaigns_completed + 1), 2) >= 4.5
             THEN 4
           -- Trusted: 30+ campaigns, avg 4.0+, currently Verified
           WHEN tester_reputation.rank = 2
             AND (tester_reputation.campaigns_completed + 1) >= 30
             AND ROUND((tester_reputation.total_score + $2) / (tester_reputation.campaigns_completed + 1), 2) >= 4.0
             THEN 3
           -- Verified: 10+ campaigns, avg 3.5+, currently Builder
           WHEN tester_reputation.rank = 1
             AND (tester_reputation.campaigns_completed + 1) >= 10
             AND ROUND((tester_reputation.total_score + $2) / (tester_reputation.campaigns_completed + 1), 2) >= 3.5
             THEN 2
           -- Builder: 3+ campaigns, avg 3.0+, currently Scout
           WHEN tester_reputation.rank = 0
             AND (tester_reputation.campaigns_completed + 1) >= 3
             AND ROUND((tester_reputation.total_score + $2) / (tester_reputation.campaigns_completed + 1), 2) >= 3.0
             THEN 1
           ELSE tester_reputation.rank
         END,
         updated_at = NOW()`,
      [wallet, provisionalScore, Math.round(auto_score / 10)]
    )

    return NextResponse.json({ success: true, auto_score, contract_verified })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
