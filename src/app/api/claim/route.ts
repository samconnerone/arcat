export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "crypto"
import { attestOnChain, subjectFor } from "@/lib/registry"
import { getPool } from "@/lib/dbPool"
import { createUnsubscribeToken } from "@/lib/unsubscribeToken"
import { attachSessionCookie, getSession } from "@/lib/session"

const pool = getPool()

export async function POST(req: NextRequest) {
  try {
    // Rate limit the magic-link email so a script can't burn through Resend quota
    const { enforce } = await import("@/lib/ratelimit")
    const blocked = await enforce(req, "claim-email", { limit: 10, windowMs: 60_000 })
    if (blocked) return blocked

    const { email, slug } = await req.json()
    if (!email?.trim() || !slug?.trim()) {
      return NextResponse.json({ error: "Email and project required" }, { status: 400 })
    }
    const result = await pool.query(
      `SELECT id, name, slug, email, owner_wallet FROM projects WHERE (slug = $1 OR id::text = $1) AND approved = true AND live = true`,
      [slug.trim()]
    )
    if (result.rows.length === 0) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const project = result.rows[0]
    if (project.email?.toLowerCase() !== email.trim().toLowerCase()) {
      return NextResponse.json({ error: "Email does not match the submission email for this project" }, { status: 403 })
    }
    // Already claimed — refuse to issue a new claim email so a compromised
    // submission inbox can't be used to overwrite ownership. Lost-wallet
    // recovery routes through support.
    if (project.owner_wallet) {
      return NextResponse.json(
        { error: "This project has already been claimed. Sign in with the wallet that owns it, or contact support if you lost access." },
        { status: 409 }
      )
    }
    const token   = randomBytes(32).toString("hex")
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await pool.query(
      `UPDATE projects SET claim_token = $1, claim_token_expires = $2, owner_email = $3 WHERE id = $4`,
      [token, expires, email.trim().toLowerCase(), project.id]
    )
    const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"
    const dashboardUrl = `${base}/activate/${project.slug || project.id}?token=${token}`
    const unsubUrl = `${base}/api/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(email.trim()))}`
    try {
      const { Resend } = await import("resend")
      const resend = new Resend(process.env.RESEND_API_KEY || "")
      await resend.emails.send({
        from:     (process.env.MAIL_FROM || ""),
        reply_to: process.env.TEAM_EMAIL || "",
        to:       email.trim(),
        subject:  `Your Arcat dashboard for ${project.name}`,
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>, <mailto:${process.env.TEAM_EMAIL || ""}?subject=unsubscribe&body=${encodeURIComponent(email.trim())}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#060c20;color:#e8ecff;"><div style="margin-bottom:32px;"><span style="font-size:20px;font-weight:700;color:#e8ecff;">Arc</span><span style="font-size:20px;font-weight:700;color:#1a56ff;">Arcat</span></div><h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#e8ecff;">Activate your founder dashboard</h1><p style="font-size:14px;color:#6b7da8;line-height:1.7;margin:0 0 8px;">Click below to activate your dashboard for <strong style="color:#e8ecff;">${project.name}</strong>.</p><p style="font-size:13px;color:#6b7da8;line-height:1.7;margin:0 0 28px;">You'll connect your wallet once — then log in directly from any device without needing another email link.</p><a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;background:#1a56ff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;margin-bottom:28px;">Activate Dashboard →</a><hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0 16px;"><p style="font-size:11px;color:#6b7da8;text-align:center;line-height:1.7;margin:0 0 8px;">Activating only links your wallet address to this listing. Arcat will never ask you for a seed phrase, private key, or wallet password, and never requests a token approval or transfer to activate a dashboard.</p><p style="font-size:11px;color:#1e2a40;text-align:center;">Link expires in 7 days. If you did not request this, ignore this email. · <a href="${unsubUrl}" style="color:#2e3a5c;text-decoration:underline;">Unsubscribe</a></p></div>`,
      })
    } catch (emailErr) { console.error("[Email]", emailErr) }
    return NextResponse.json({ success: true, message: "Check your email for the dashboard link", debug_url: process.env.NODE_ENV === "development" ? dashboardUrl : undefined })
  } catch (err) { console.error("[Claim POST]", err); return NextResponse.json({ error: "Server error" }, { status: 500 }) }
}

export async function GET(req: NextRequest) {
  try {
    const slug   = req.nextUrl.searchParams.get("slug")
    const token  = req.nextUrl.searchParams.get("token")
    const wallet = req.nextUrl.searchParams.get("wallet")
    if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 })
    let projectRow: any = null
    if (wallet) {
      const session = getSession(req)
      if (!session || session.addr !== wallet.toLowerCase()) {
        return NextResponse.json({ error: "Sign in with this wallet first" }, { status: 401 })
      }
      const result = await pool.query(
        `SELECT id, name, slug, tagline, description, category, logo_url, website, twitter, github, discord, contract, contracts, founder_social, featured, badge, color, email, claimed_at, view_count, owner_wallet, city, country, trust_level, recognition, established FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2 AND approved = true AND live = true`,
        [slug, wallet.toLowerCase()]
      )
      if (result.rows.length === 0) return NextResponse.json({ error: "Wallet not authorized for this project" }, { status: 403 })
      projectRow = result.rows[0]
    } else if (token) {
      const result = await pool.query(
        `SELECT id, name, slug, tagline, description, category, logo_url, website, twitter, github, discord, contract, contracts, founder_social, featured, badge, color, email, claimed_at, view_count, owner_wallet, city, country, trust_level, recognition, established, claim_token_expires FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
        [slug, token]
      )
      if (result.rows.length === 0) return NextResponse.json({ error: "Invalid or expired token" }, { status: 403 })
      if (new Date(result.rows[0].claim_token_expires) < new Date()) return NextResponse.json({ error: "Token expired" }, { status: 403 })
      projectRow = result.rows[0]
      if (projectRow.owner_wallet) {
        const session = getSession(req)
        if (!session || session.addr !== String(projectRow.owner_wallet).toLowerCase()) {
          return NextResponse.json({ error: "This activation link has already been used. Sign in with the owner wallet." }, { status: 401 })
        }
      } else {
        // A claim link may identify the listing being activated, but it must not
        // expose founder email, reviews, analytics, or other dashboard data.
        return NextResponse.json({
          project: {
            id: projectRow.id,
            name: projectRow.name,
            slug: projectRow.slug,
            logo_url: projectRow.logo_url,
            category: projectRow.category,
            owner_wallet: null,
          },
          hasWallet: false,
        }, { headers: { "Cache-Control": "no-store" } })
      }
      // Do NOT set claimed_at here. The link being opened is not a claim;
      // claimed_at flips when the wallet is actually attached in PUT below.
    } else {
      return NextResponse.json({ error: "Missing token or wallet" }, { status: 400 })
    }
    const reviews   = await pool.query(`SELECT id, wallet, category, rating, review_text, is_public, contact, badge, created_at FROM reviews WHERE project_id = $1 ORDER BY created_at DESC`, [projectRow.id])
    const weekNum   = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))

    // Everything below feeds the dashboard's "needs your attention" panel and
    // listing-health readout. All of it is state the founder could already be
    // in — they just had no way to discover it without clicking through every
    // tab. Run in parallel and fail soft: a dashboard that loads without its
    // health readout is fine, one that 500s because a side query failed is not.
    const [weekViews, prevViews, pending, unrated, scan] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM project_views WHERE project_id = $1 AND week_num = $2`, [projectRow.id, weekNum]),
      pool.query(`SELECT COUNT(*) AS cnt FROM project_views WHERE project_id = $1 AND week_num = $2`, [projectRow.id, weekNum - 1]).catch(() => null),
      pool.query(
        `SELECT count(*)::int AS n, min(submitted_at) AS oldest,
                array_agg(DISTINCT field) AS fields
           FROM pending_updates WHERE project_id = $1 AND status = 'pending'`, [projectRow.id]).catch(() => null),
      // Submissions the founder still owes a rating on, across every campaign
      // this project runs.
      pool.query(
        `SELECT count(*)::int AS n, min(cc.created_at) AS oldest
           FROM campaign_completions cc
           JOIN campaigns c ON c.id = cc.campaign_id
          WHERE c.project_id = $1 AND cc.builder_rating IS NULL`, [projectRow.id]).catch(() => null),
      projectRow.website
        ? pool.query(`SELECT verdict, malicious, suspicious, scanned_at FROM url_scans WHERE url = $1 ORDER BY scanned_at DESC LIMIT 1`, [projectRow.website]).catch(() => null)
        : Promise.resolve(null),
    ])

    return NextResponse.json({
      project: { ...projectRow, claim_token: undefined, claim_token_expires: undefined },
      reviews: reviews.rows,
      weekViews: parseInt(weekViews.rows[0]?.cnt || "0"),
      prevWeekViews: parseInt(prevViews?.rows[0]?.cnt || "0"),
      hasWallet: !!projectRow.owner_wallet,
      pendingUpdate: (pending?.rows[0]?.n || 0) > 0
        ? { count: pending!.rows[0].n, oldest: pending!.rows[0].oldest, fields: (pending!.rows[0].fields || []).filter(Boolean) }
        : null,
      unratedSubmissions: (unrated?.rows[0]?.n || 0) > 0
        ? { count: unrated!.rows[0].n, oldest: unrated!.rows[0].oldest }
        : null,
      urlScan: scan?.rows[0] || null,
    })
  } catch (err) { console.error("[Claim GET]", err); return NextResponse.json({ error: "Server error" }, { status: 500 }) }
}

const SIG_MAX_AGE_MS = 5 * 60 * 1000

function buildActivationMessage(projectName: string, wallet: string, timestamp: number): string {
  return `Arcat Founder Dashboard Activation\nProject: ${projectName}\nWallet: ${wallet}\nTimestamp: ${timestamp}`
}

async function verifyFounderAuth(
  projectName: string,
  wallet: string,
  auth: any
): Promise<{ ok: boolean; error?: string }> {
  if (!auth || typeof auth !== "object") return { ok: false, error: "Missing wallet proof" }
  const addr = wallet.toLowerCase()

  if (auth.type === "wallet") {
    const { signature, timestamp } = auth
    if (!signature || !timestamp) return { ok: false, error: "Missing signature" }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_MAX_AGE_MS) {
      return { ok: false, error: "Signature expired — please try again" }
    }
    const message = buildActivationMessage(projectName, addr, ts)
    try {
      const { verifyMessage } = await import("viem")
      const valid = await verifyMessage({
        address:   addr as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      })
      if (!valid) return { ok: false, error: "Signature does not match wallet" }
      return { ok: true }
    } catch {
      return { ok: false, error: "Invalid signature" }
    }
  }

  if (auth.type === "circle") {
    return { ok: false, error: "Sign in with the Circle email code first" }
  }

  return { ok: false, error: "Unknown auth type" }
}

export async function PUT(req: NextRequest) {
  try {
    const { enforce } = await import("@/lib/ratelimit")
    const blocked = await enforce(req, "claim-activate", { limit: 10, windowMs: 60_000 })
    if (blocked) return blocked

    const { token, slug, wallet, auth } = await req.json()
    if (!token || !slug || !wallet) return NextResponse.json({ error: "Missing fields" }, { status: 400 })

    const addr = String(wallet).toLowerCase().trim()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
    }

    const result = await pool.query(
      `SELECT id, name, claim_token_expires, owner_wallet FROM projects WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
      [slug, token]
    )
    if (result.rows.length === 0) return NextResponse.json({ error: "Invalid token" }, { status: 403 })
    if (new Date(result.rows[0].claim_token_expires) < new Date()) {
      return NextResponse.json({ error: "Token expired" }, { status: 403 })
    }
    // Defense in depth: even with a valid token + signature, never silently
    // overwrite an existing owner. A different wallet trying to claim the
    // same project has to go through support.
    const existingOwner = result.rows[0].owner_wallet
    if (existingOwner && existingOwner.toLowerCase() !== addr) {
      return NextResponse.json(
        { error: "This project is already claimed by another wallet. Contact support if you need to transfer ownership." },
        { status: 409 }
      )
    }

    // Tamper-proof: token alone is no longer enough — must prove wallet ownership.
    // Accept either a valid session cookie for this address or a fresh signature.
    const sess = getSession(req)
    if (!sess || sess.addr !== addr) {
      const authResult = await verifyFounderAuth(result.rows[0].name, addr, auth)
      if (!authResult.ok) {
        return NextResponse.json({ error: authResult.error || "Wallet verification failed" }, { status: 401 })
      }
    }

    // Set owner_wallet + claimed_at atomically — claimed_at now truthfully means
    // "wallet attached", not "email link opened". Also auto-promote the trust
    // ladder to 'claimed' (a real owner controls the listing) — objective, no
    // manual step. Recognition (Arc Partner/Official) outranks and is left alone.
    await pool.query(
       `UPDATE projects SET
         owner_wallet = $1,
         claimed_at   = COALESCE(claimed_at, NOW()),
         claim_token = NULL,
         claim_token_expires = NULL,
         trust_level  = CASE WHEN trust_level = 'listed' OR trust_level IS NULL THEN 'claimed' ELSE trust_level END
       WHERE id = $2`,
      [addr, result.rows[0].id]
    )

    // Mirror the new trust state on-chain (env-gated no-op until the registry is
    // configured). Claiming moves the ladder listed→claimed, so the published
    // attestation should reflect it — keeps the chain a complete, current record.
    try {
      const after = (await pool.query(
        `SELECT trust_level, recognition, slug, established,
                (SELECT address FROM project_contracts WHERE project_id = projects.id AND verified_at IS NOT NULL AND revoked_at IS NULL LIMIT 1) AS proven
           FROM projects WHERE id = $1`, [result.rows[0].id]
      )).rows[0]
      const subject = subjectFor({ provenContract: after?.proven, slug: after?.slug })
      if (subject) attestOnChain(subject, after.trust_level, after.recognition, "ecosystem/" + (after.slug || ""), !!after.established).catch(() => {})
    } catch {}

    const response = NextResponse.json({ success: true })
    if (!sess || sess.addr !== addr) {
      attachSessionCookie(response, { addr, type: auth?.type === "circle" ? "circle" : "wallet" })
    }
    return response
  } catch (err) { console.error("[Claim PUT]", err); return NextResponse.json({ error: "Server error" }, { status: 500 }) }
}

export async function PATCH(req: NextRequest) {
  try {
    const { wallet } = await req.json()
    if (!wallet) return NextResponse.json({ error: "Missing wallet" }, { status: 400 })
    const addr = String(wallet).toLowerCase()
    const session = getSession(req)
    if (!session || session.addr !== addr) {
      return NextResponse.json({ error: "Sign in with this wallet first" }, { status: 401 })
    }
    const result = await pool.query(
      `SELECT id, name, slug FROM projects WHERE owner_wallet = $1 AND approved = true AND live = true`,
      [addr]
    )
    return NextResponse.json({ projects: result.rows })
  } catch (err) { console.error("[Claim PATCH]", err); return NextResponse.json({ error: "Server error" }, { status: 500 }) }
}
