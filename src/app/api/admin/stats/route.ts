export const runtime = "nodejs"
import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { getPool } from "@/lib/dbPool"

// Site-wide stats panel for the admin dashboard — milestone tracking + the
// numbers you'll want at hand for grant submissions (Circle, etc.). One query
// per metric is fine here: this runs once on admin load, not per request, and
// every metric is a simple aggregate over a small table.

const pool = getPool()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""

function checkAuth(pw: string): boolean {
  if (!ADMIN_PASSWORD || !pw) return false
  const a = Buffer.from(pw)
  const b = Buffer.from(ADMIN_PASSWORD)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function num(sql: string): Promise<number> {
  try {
    const r = await pool.query(sql)
    const v = r.rows[0] ? Object.values(r.rows[0])[0] : 0
    return Number(v) || 0
  } catch { return 0 }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || ""
  const pw = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!checkAuth(pw)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Union of every wallet-bearing table = the true "wallets engaged" number.
  // We can't count "connections" directly (cookie auth doesn't write to DB),
  // but any wallet that has TAKEN an action (own project, complete campaign,
  // review, claim contract, create campaign, build profile, etc.) is engaged.
  const TOTAL_WALLETS_SQL = `
    SELECT COUNT(DISTINCT w) FROM (
      SELECT LOWER(owner_wallet) w  FROM projects               WHERE owner_wallet  IS NOT NULL
      UNION SELECT LOWER(tester_wallet) FROM campaign_completions WHERE tester_wallet IS NOT NULL
      UNION SELECT LOWER(wallet)        FROM reviews              WHERE wallet         IS NOT NULL
      UNION SELECT LOWER(wallet)        FROM tester_reputation    WHERE wallet         IS NOT NULL
      UNION SELECT LOWER(deployer)      FROM contracts            WHERE deployer       IS NOT NULL
      UNION SELECT LOWER(creator_wallet) FROM campaigns           WHERE creator_wallet IS NOT NULL
      UNION SELECT LOWER(address)       FROM builder_profiles     WHERE address        IS NOT NULL
    ) z
  `

  // Parallel — one round-trip's worth of latency for the whole panel.
  const [
    projectsLive, projectsTotal, projectsClaimed,
    contractsClaimed, contractsVerified,
    campaignsTotal, campaignsActive,
    completionsTotal, completionsReviewed, completionsClaimed,
    totalWallets, uniqueTesters, uniqueFounders, uniqueReviewers,
    uniqueClaimers, circleUsers, builderProfiles,
    xpAwarded, usdcPaid,
    reviewsTotal, projectViews,
    projects30d, completions30d, completions7d, activeTesters7d,
    visitorsToday, visitors7d, visitors30d, pageViews30d,
  ] = await Promise.all([
    num("SELECT COUNT(*) FROM projects WHERE approved AND live"),
    num("SELECT COUNT(*) FROM projects"),
    num("SELECT COUNT(*) FROM projects WHERE owner_wallet IS NOT NULL"),
    num("SELECT COUNT(*) FROM contracts WHERE badge IN ('claimed','verified','official')"),
    num("SELECT COUNT(*) FROM contracts WHERE badge='verified'"),
    num("SELECT COUNT(*) FROM campaigns"),
    num("SELECT COUNT(*) FROM campaigns WHERE status IN ('active','approved')"),
    num("SELECT COUNT(*) FROM campaign_completions"),
    num("SELECT COUNT(*) FROM campaign_completions WHERE status='reviewed'"),
    num("SELECT COUNT(*) FROM campaign_completions WHERE reward_delivered"),
    num(TOTAL_WALLETS_SQL),
    num("SELECT COUNT(DISTINCT tester_wallet) FROM campaign_completions"),
    num("SELECT COUNT(DISTINCT owner_wallet) FROM projects WHERE owner_wallet IS NOT NULL"),
    num("SELECT COUNT(DISTINCT wallet) FROM reviews WHERE wallet IS NOT NULL"),
    num("SELECT COUNT(DISTINCT deployer) FROM contracts WHERE deployer IS NOT NULL"),
    num("SELECT COUNT(*) FROM circle_wallet_users"),
    num("SELECT COUNT(*) FROM builder_profiles"),
    num("SELECT COALESCE(SUM(xp_earned),0) FROM campaign_completions WHERE xp_earned IS NOT NULL"),
    num(`SELECT COALESCE(SUM(reward_usdc_amount),0) FROM campaign_completions cc JOIN campaigns c ON c.id=cc.campaign_id WHERE cc.reward_delivered AND c.reward_type='usdc'`),
    num("SELECT COUNT(*) FROM reviews"),
    num("SELECT COUNT(*) FROM project_views"),
    num("SELECT COUNT(*) FROM projects WHERE created_at > NOW() - INTERVAL '30 days'"),
    num("SELECT COUNT(*) FROM campaign_completions WHERE created_at > NOW() - INTERVAL '30 days'"),
    num("SELECT COUNT(*) FROM campaign_completions WHERE created_at > NOW() - INTERVAL '7 days'"),
    num("SELECT COUNT(DISTINCT tester_wallet) FROM campaign_completions WHERE created_at > NOW() - INTERVAL '7 days'"),
    // Traffic (cookieless page_visits). num() returns 0 if the table doesn't exist yet.
    num("SELECT COUNT(DISTINCT device_id) FROM page_visits WHERE day = CURRENT_DATE"),
    num("SELECT COUNT(DISTINCT device_id) FROM page_visits WHERE day >= CURRENT_DATE - 6"),
    num("SELECT COUNT(DISTINCT device_id) FROM page_visits WHERE day >= CURRENT_DATE - 29"),
    num("SELECT COUNT(*) FROM page_visits WHERE day >= CURRENT_DATE - 29"),
  ])

  // Top pages by unique visitors (last 30d) — its own query since it returns rows.
  let topPages: Array<{ path: string; visitors: number }> = []
  try {
    const tp = await pool.query(
      `SELECT path, COUNT(DISTINCT device_id)::int AS visitors
         FROM page_visits WHERE day >= CURRENT_DATE - 29
         GROUP BY path ORDER BY visitors DESC LIMIT 8`,
    )
    topPages = tp.rows as any
  } catch { /* table not created yet */ }

  return NextResponse.json({
    users: {
      totalWallets,        // Union of all wallet-bearing tables — the headline "users" number
      circleUsers,         // Circle Dev Wallet (email-onboarded) users
      uniqueTesters,       // wallets that completed >=1 campaign
      uniqueFounders,      // wallets that own >=1 project
      uniqueReviewers,     // wallets that left >=1 review
      uniqueClaimers,      // wallets that claimed >=1 contract
      builderProfiles,     // public builder profile rows
    },
    ecosystem: {
      projectsLive, projectsTotal, projectsClaimed,
      contractsClaimed, contractsVerified,
    },
    activity: {
      campaignsTotal, campaignsActive,
      completionsTotal, completionsReviewed, completionsClaimed,
      reviewsTotal, projectViews,
    },
    economy: {
      xpAwarded, usdcPaid,
    },
    growth30d: {
      projects: projects30d,
      completions: completions30d,
    },
    momentum7d: {
      completions: completions7d,
      activeTesters: activeTesters7d,
    },
    traffic: {
      visitorsToday,       // unique devices today
      visitors7d,          // unique devices, last 7 days
      visitors30d,         // unique devices, last 30 days
      pageViews30d,        // total page visits, last 30 days
      topPages,            // [{ path, visitors }] — most-visited pages, 30d
    },
    generated_at: new Date().toISOString(),
  })
}
