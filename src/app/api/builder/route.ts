export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { verifyMessage } from "viem"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

// Anti-spam minimums — server-side, so no client bypass
const MIN_NAME_LEN   = 2
const MIN_BIO_LEN    = 30
const SIG_MAX_AGE_MS = 5 * 60 * 1000

function buildClaimMessage(address: string, timestamp: number): string {
  return `Arcat Builder Profile Claim\nWallet: ${address}\nTimestamp: ${timestamp}`
}

async function verifyClaimAuth(addr: string, auth: any): Promise<{ ok: boolean; error?: string }> {
  if (!auth || typeof auth !== "object") return { ok: false, error: "Missing wallet proof" }

  if (auth.type === "wallet") {
    const { signature, timestamp } = auth
    if (!signature || !timestamp) return { ok: false, error: "Missing signature" }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_MAX_AGE_MS) {
      return { ok: false, error: "Signature expired — please try again" }
    }
    const message = buildClaimMessage(addr, ts)
    try {
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

function validateProfileFields(b: {
  display_name?: string, bio?: string, avatar_url?: string,
  twitter?: string, github?: string, website?: string, telegram?: string,
}): string | null {
  const name = (b.display_name || "").trim()
  const bio  = (b.bio          || "").trim()
  const av   = (b.avatar_url   || "").trim()
  const socials = [b.twitter, b.github, b.website, b.telegram].map(s => (s || "").trim()).filter(Boolean)

  if (name.length < MIN_NAME_LEN) return `Display name must be at least ${MIN_NAME_LEN} characters`
  if (bio.length  < MIN_BIO_LEN)  return `Bio must be at least ${MIN_BIO_LEN} characters`
  if (!av)                        return "Profile photo is required"
  if (socials.length === 0)       return "Add at least one social link (X, GitHub, website, or Telegram)"
  return null
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS builder_profiles (
      address      TEXT PRIMARY KEY,
      display_name TEXT,
      bio          TEXT,
      avatar_url   TEXT,
      twitter      TEXT,
      github       TEXT,
      website      TEXT,
      telegram     TEXT,
      email        TEXT,
      verified     BOOLEAN DEFAULT false,
      claimed_at   TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  // Safe to run on existing tables — no-op if column already exists
  await pool.query(`ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS email TEXT`)
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.toLowerCase()
  if (!address) return NextResponse.json({ error: "Missing address" }, { status: 400 })

  try {
    await ensureTable()
    const session = getSession(req)
    const isOwner = session?.addr === address

    const [profileRes, projectsRes, pendingRes] = await Promise.all([
      pool.query(`SELECT * FROM builder_profiles WHERE address = $1`, [address]),
      pool.query(
        `SELECT id, name, slug, tagline, category, logo_url, website, featured, badge,
                COALESCE(view_count, 0) as view_count, contract, created_at
         FROM projects WHERE owner_wallet = $1 AND approved = true AND live = true
         ORDER BY featured DESC, view_count DESC`,
        [address]
      ),
      // Detect pending projects via either source of email truth:
      // 1. Email on a project they already claimed (owner_wallet = address)
      // 2. Email they entered directly on their builder profile
      isOwner ? pool.query(
        `SELECT id, name, slug FROM projects
         WHERE owner_wallet IS NULL
           AND approved = true AND live = true
           AND email IN (
             SELECT email FROM projects
             WHERE owner_wallet = $1 AND email IS NOT NULL
             UNION
             SELECT email FROM builder_profiles
             WHERE address = $1 AND email IS NOT NULL
           )`,
        [address]
      ) : Promise.resolve({ rows: [] }),
    ])

    const profile = profileRes.rows[0] || null

    const contractAddresses: string[] = projectsRes.rows
      .map((p: any) => p.contract as string | null)
      .filter((c): c is string => !!c && /^0x[0-9a-fA-F]{40}$/i.test(c))

    let contractsDeployed = 0
    let contractActivity  = 0
    let firstSeen: string | null = null

    try {
      const [txsRes, ...contractRes] = await Promise.all([
        fetch(`https://testnet.arcscan.app/api/v2/addresses/${address}/transactions?limit=50`, {
          headers: { Accept: "application/json" },
          next: { revalidate: 60 },
        }),
        ...contractAddresses.map(c =>
          fetch(`https://testnet.arcscan.app/api/v2/addresses/${c}`, {
            headers: { Accept: "application/json" },
            next: { revalidate: 60 },
          })
        ),
      ])

      if (txsRes.ok) {
        const data = await txsRes.json()
        const txs: any[] = data.items || []
        contractsDeployed = txs.filter(
          (t: any) => t.from?.hash?.toLowerCase() === address && t.created_contract != null
        ).length
        const oldest = txs[txs.length - 1]
        if (oldest?.timestamp) firstSeen = oldest.timestamp
      }

      for (const res of contractRes) {
        if (res?.ok) {
          const d = await res.json()
          contractActivity += parseInt(d.transactions_count || "0")
        }
      }
    } catch {}

    return NextResponse.json({
      // email is intentionally excluded from the public response — private field
      profile: profile ? { ...profile, email: undefined } : null,
      hasSubmissionEmail: isOwner && !!profile?.email,
      projects:           projectsRes.rows,
      pendingProjects:    pendingRes.rows,
      stats: {
        contractsDeployed,
        projectsShipped: projectsRes.rows.length,
        contractActivity,
        firstSeen,
      },
    }, { headers: { "Cache-Control": isOwner ? "no-store" : "public, s-maxage=60, stale-while-revalidate=120" } })
  } catch (err) {
    console.error("[Builder GET]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const blocked = await enforce(req, "builder-save", { limit: 20, windowMs: 60_000 })
    if (blocked) return blocked

    await ensureTable()
    const body = await req.json()
    const { address, display_name, bio, avatar_url, twitter, github, website, telegram, email, auth } = body

    if (!address?.trim()) return NextResponse.json({ error: "Missing address" }, { status: 400 })
    const addr = address.toLowerCase().trim()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 })
    }

    // Tamper-proof: must prove ownership of the wallet — session cookie OR per-request auth proof
    const sess = getSession(req)
    if (!sess || sess.addr !== addr) {
      const authResult = await verifyClaimAuth(addr, auth)
      if (!authResult.ok) {
        return NextResponse.json({ error: authResult.error || "Wallet verification failed" }, { status: 401 })
      }
    }

    // Hard validation: server-side, can't be bypassed by hitting the API directly
    const validationError = validateProfileFields({ display_name, bio, avatar_url, twitter, github, website, telegram })
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    await pool.query(
      `INSERT INTO builder_profiles (address, display_name, bio, avatar_url, twitter, github, website, telegram, email, claimed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (address) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         bio          = EXCLUDED.bio,
         avatar_url   = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), builder_profiles.avatar_url),
         twitter      = EXCLUDED.twitter,
         github       = EXCLUDED.github,
         website      = EXCLUDED.website,
         telegram     = EXCLUDED.telegram,
         email        = COALESCE(NULLIF(EXCLUDED.email, ''), builder_profiles.email),
         claimed_at   = COALESCE(builder_profiles.claimed_at, NOW()),
         updated_at   = NOW()`,
      [addr, display_name?.trim() || null, bio?.trim() || null, avatar_url?.trim() || null,
       twitter?.trim() || null, github?.trim() || null, website?.trim() || null,
       telegram?.trim() || null, email?.trim()?.toLowerCase() || null]
    )

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[Builder POST]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
