import { NextRequest, NextResponse, after } from "next/server"
import { scanUrl } from "@/lib/urlScan"
import { getPool } from "@/lib/dbPool"
import { validateEmail, validateWebsite, hostFromUrl, domainResolves } from "@/lib/submissionGuards"
import { extractTags } from "@/lib/projectTags"
import { sendSubmissionCode, verifySubmissionCode } from "@/lib/submissionOtp"

const pool = getPool()

// Every accepted submission gets a reference the founder can quote back to us.
// Alphabet excludes I, O, 0 and 1 so a code read off a screen and typed into an
// email can't come back as something different.
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

let refColumnReady: Promise<unknown> | null = null
function ensureRefColumn() {
  if (!refColumnReady) {
    refColumnReady = pool
      .query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS submission_ref TEXT`)
      .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS projects_submission_ref_idx ON projects (submission_ref) WHERE submission_ref IS NOT NULL`))
      .catch(e => { refColumnReady = null; throw e })
  }
  return refColumnReady
}

async function newSubmissionRef(): Promise<string> {
  await ensureRefColumn()
  for (let attempt = 0; attempt < 6; attempt++) {
    let body = ""
    for (let i = 0; i < 5; i++) body += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)]
    const ref = `ARC-${body}`
    const clash = await pool.query("SELECT 1 FROM projects WHERE submission_ref = $1 LIMIT 1", [ref])
    if (!clash.rows.length) return ref
  }
  // Astronomically unlikely; fall back to something guaranteed unique rather
  // than failing an otherwise valid submission.
  return `ARC-${Date.now().toString(36).toUpperCase().slice(-5)}`
}

export async function GET() {
  try {
    const result = await pool.query(
      `SELECT id, name, tagline,
              -- Cards show only the first ~120 chars; ship 121 (enough for the
              -- "…" check) instead of the full 300, and ship only the one
              -- trust_profile field the list uses (hard_risk) instead of the
              -- whole analysis blob. Together this ~halves the list payload —
              -- the biggest single source of DB egress. Detail page keeps both.
              LEFT(description, 121) AS description,
              -- Full text is read only to derive search tags below and is then
              -- dropped before responding — the client still receives just the
              -- 121-char excerpt. Costs one extra read per cache miss (~once an
              -- hour) and saves shipping ~300 chars x 310 rows to every visitor.
              description AS description_full,
              category, logo_url,
              website, twitter, github, discord, contract,
              featured, color, launched_at, slug, badge,
              trust_level, recognition, established,
              json_build_object('hard_risk', COALESCE((trust_profile->>'hard_risk')::bool, false)) AS trust_profile,
              city, country, lat, lng,
              COALESCE(view_count, 0) as view_count,
              created_at,
              -- TVL / Revenue tracking. The directory cards + sort/filter only
              -- read these five fields; the per-day ATH breakdowns (tvl_ath_*,
              -- revenue_ath_day*, volume_ath_day*, tvl_last_indexed_at) are shown
              -- only on the detail page, which fetches them via /api/ecosystem/[id].
              -- Shipping them for all ~300 rows here was pure egress waste.
              tvl_tracking_enabled,
              tvl_usd_e6::text          AS tvl_usd_e6,
              tvl_ath_usd_e6::text      AS tvl_ath_usd_e6,
              revenue_cum_usd_e6::text  AS revenue_cum_usd_e6,
              volume_cum_usd_e6::text   AS volume_cum_usd_e6
       FROM projects
       WHERE approved = true AND live = true
       ORDER BY featured DESC, COALESCE(view_count, 0) DESC, created_at DESC`
    )

    // Trending: most unique viewers in the last ~2 weeks. project_views dedups
    // per device per week (week_num), so this is real recent interest — not the
    // frozen lifetime view_count tally, which kept the same projects on top
    // forever. Falls back to all-time views when recent data is sparse so the
    // rail is never empty. No external API calls.
    // Derive search tags from the full text, then drop it — the client still
    // receives only the 121-char excerpt. Someone hunting for "USDC vaults" was
    // finding nothing because search only ever saw name and tagline, and the
    // word "vault" almost always lives in the description.
    const projectsRows = result.rows.map((p: any) => {
      const { description_full, ...rest } = p
      return {
        ...rest,
        tags: extractTags(`${p.name || ""} ${p.tagline || ""} ${description_full || ""}`),
      }
    })
    const currentWeek  = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))
    let trending: any[] = []
    try {
      const recent = await pool.query(
        `SELECT project_id, COUNT(*)::int AS recent_views
           FROM project_views
          WHERE week_num >= $1
          GROUP BY project_id
          ORDER BY recent_views DESC
          LIMIT 12`,
        [currentWeek - 1],
      )
      // projects.id is bigint (pg returns a string) while project_views.project_id
      // is integer (pg returns a number) — normalize both to String to match.
      const byId = new Map(projectsRows.map((p: any) => [String(p.id), p]))
      trending = recent.rows
        .map((r: any) => { const p = byId.get(String(r.project_id)); return p ? { ...p, tx_count: r.recent_views } : null })
        .filter(Boolean)
        .slice(0, 5)
    } catch { trending = [] }

    if (trending.length < 5) {
      const seen = new Set(trending.map((p: any) => p.id))
      const fill = [...projectsRows]
        .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
        .filter((p: any) => !seen.has(p.id))
        .slice(0, 5 - trending.length)
        .map((p: any) => ({ ...p, tx_count: 0 }))
      trending = [...trending, ...fill]
    }

    return NextResponse.json({ projects: projectsRows, trending }, {
      // Directory isn't real-time — new listings appear on approval, which is
      // infrequent. A 1-hour CDN cache (with a 2-hour stale window so visitors
      // are always served instantly while it revalidates in the background)
      // cuts origin DB revalidations ~4x vs the old 15 min — the single biggest
      // egress lever here — with no visible staleness.
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
    })
  } catch {
    return NextResponse.json({ projects: [], trending: [] })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, tagline, description, category, website, twitter, github, discord, contract, contracts: extraContracts, logo_url, email, city, country, founder, code } = body
  const founderSocial = typeof founder === "string" ? founder.trim() || null : null
  const contractsArr = Array.isArray(extraContracts) ? extraContracts.map((c: string) => c.trim()).filter(Boolean) : []
  // Cap tagline + description so cards/listings stay neat (the form enforces
  // these too; this is the server-side safety net). Tagline 80, description 300.
  const cleanTagline = typeof tagline === "string" ? tagline.trim().slice(0, 80) : ""
  const cleanDesc = typeof description === "string" ? (description.trim().slice(0, 300) || null) : null

  if (!name?.trim())    return NextResponse.json({ error: "Project name required" }, { status: 400 })
  if (!tagline?.trim()) return NextResponse.json({ error: "Tagline required" }, { status: 400 })

  // ── Intake validation ─────────────────────────────────────────────────────
  // Reject junk before it reaches the admin queue: bad emails, reserved/
  // unregisterable domains (.invalid/.example/etc), and a project with neither
  // a resolving website nor a contract. Complements the reputation scan.
  const emailCheck = validateEmail(email)
  if (emailCheck.ok === false) return NextResponse.json({ error: emailCheck.error }, { status: 400 })

  const siteCheck = validateWebsite(website)
  if (siteCheck.ok === false) return NextResponse.json({ error: siteCheck.error }, { status: 400 })

  // At least ONE verifiable link — but generously: a real website, a contract,
  // OR a social (Twitter/GitHub). Early projects often have only a Twitter, and
  // we don't want to turn them away — we just refuse the truly empty submission
  // that names no way to check the team is real (the audit-probe case).
  const hasContract = typeof contract === "string" && /^0x[a-fA-F0-9]{40}$/.test(contract.trim())
  const hasWebsite  = !!(website && website.trim())
  const hasSocial   = !!((twitter && twitter.trim()) || (github && github.trim()))
  if (!hasContract && !hasWebsite && !hasSocial) {
    return NextResponse.json({ error: "Add at least one link so we can verify your project — a website, contract address, Twitter, or GitHub." }, { status: 400 })
  }

  // If a website was given, confirm the domain actually resolves (fail-open on
  // DNS outage). Stops fabricated-but-well-formed domains like the audit probe.
  if (hasWebsite) {
    const host = hostFromUrl(website)
    if (host && !(await domainResolves(host))) {
      return NextResponse.json({ error: "That website domain doesn't resolve — check the URL and try again" }, { status: 400 })
    }
  }

  // ── Email ownership ───────────────────────────────────────────────────────
  // Everything above is free to check, so a doomed submission never costs an
  // email. From here the address has to prove itself: the first POST sends a
  // code and writes nothing, the second carries the code back and commits.
  // Without this, every later approval or rejection email could be going to a
  // typo'd or invented inbox — which is how a sender quietly ends up mailing
  // spam traps.
  const submitterEmail = email.trim().toLowerCase()
  if (!code || !String(code).trim()) {
    const sent = await sendSubmissionCode(submitterEmail, name)
    if (sent.ok === false) return NextResponse.json({ error: sent.error }, { status: sent.status })
    return NextResponse.json({ needsVerification: true, email: submitterEmail })
  }
  const codeCheck = await verifySubmissionCode(submitterEmail, String(code).trim())
  if (codeCheck.ok === false) return NextResponse.json({ error: codeCheck.error }, { status: codeCheck.status })

  // Generate slug from name
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

  try {
    if (contract?.trim()) {
      const existing = await pool.query(
        "SELECT id, email FROM projects WHERE contract = $1 LIMIT 1",
        [contract.trim().toLowerCase()]
      )

      if (existing.rows.length > 0) {
        const existingEmail = existing.rows[0].email?.toLowerCase()
        const submittedEmail = email.trim().toLowerCase()

        if (existingEmail === submittedEmail) {
          await pool.query(
            `UPDATE projects SET
               name = $1, tagline = $2, description = $3, category = $4,
               logo_url = COALESCE($5, logo_url),
               website = $6, twitter = $7, github = $8, discord = $9,
               founder_social = COALESCE($11, founder_social),
               approved = false, live = false
             WHERE contract = $10`,
            [name.trim(), cleanTagline, cleanDesc, category||"DeFi",
             logo_url||null, website?.trim()||null, twitter?.trim()||null,
             github?.trim()||null, discord?.trim()||null, contract.trim().toLowerCase(), founderSocial]
          )
          // Re-issue a reference so a resubmission is trackable too, but keep
          // the original if this project already has one.
          await ensureRefColumn()
          const prevRef = (await pool.query(
            "SELECT submission_ref FROM projects WHERE contract = $1", [contract.trim().toLowerCase()],
          )).rows[0]?.submission_ref
          const ref = prevRef || await newSubmissionRef()
          if (!prevRef) {
            await pool.query("UPDATE projects SET submission_ref = $1 WHERE contract = $2",
              [ref, contract.trim().toLowerCase()])
          }
          if (website?.trim()) after(() => scanUrl(website))
          return NextResponse.json({ success: true, updated: true, reference: ref })
        } else {
          return NextResponse.json({ error: "A project with this contract address already exists. Use the same email you registered with to update it." }, { status: 409 })
        }
      }
    }

    // New submission — slug must be derived purely from the project name.
    // If the slug is already taken, reject with a clear error so the founder
    // picks a different name (e.g. "Tower Exchange" instead of "Tower").
    // This keeps every slug human-readable and tied to the brand — no random
    // timestamps, no -2/-3 counters polluting public URLs.
    const slugCheck = await pool.query(
      "SELECT id, name FROM projects WHERE slug = $1 LIMIT 1",
      [slug]
    )
    if (slugCheck.rows.length > 0) {
      return NextResponse.json({
        error: `A project named "${slugCheck.rows[0].name}" already uses this URL. Pick a more specific project name (e.g. "${name.trim()} Labs" or "${name.trim()} Protocol") and resubmit.`,
      }, { status: 409 })
    }
    const finalSlug = slug

    const reference = await newSubmissionRef()
    await pool.query(
      `INSERT INTO projects (name, tagline, description, category, logo_url, website, twitter, github, discord, contract, contracts, email, city, country, founder_social, approved, live, slug, submission_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,false,$16,$17)`,
      [name.trim(), cleanTagline, cleanDesc, category||"DeFi",
       logo_url||null, website?.trim()||null, twitter?.trim()||null,
       github?.trim()||null, discord?.trim()||null,
       contract?.trim()?.toLowerCase()||null, contractsArr, email.trim(),
       city?.trim()||null, country?.trim()||null, founderSocial, finalSlug, reference]
    )
    // Reputation-scan the submitted website (VirusTotal) after responding —
    // the verdict lands in url_scans and shows in the admin review panel.
    if (website?.trim()) after(() => scanUrl(website))
    return NextResponse.json({ success: true, updated: false, reference })
  } catch (err) {
    console.error("[Ecosystem POST]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
