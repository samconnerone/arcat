export const runtime = "nodejs"
import { NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function GET() {
  try {
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
    await pool.query(`ALTER TABLE builder_profiles ADD COLUMN IF NOT EXISTS email TEXT`)

    // Public directory excludes incomplete profiles so spam/empty claims don't pollute the list.
    // Requirements: display_name + bio (≥30 chars) + avatar + at least one social link.
    const res = await pool.query(`
      SELECT
        b.address,
        b.display_name,
        b.bio,
        b.avatar_url,
        b.twitter,
        b.github,
        b.website,
        b.verified,
        b.claimed_at,
        COUNT(p.id)::int                    AS project_count,
        COALESCE(SUM(p.view_count), 0)::int AS total_views,
        (
          (COUNT(p.id) * 500)
          + LEAST(COALESCE(SUM(p.view_count), 0), 5000)
        )::int                              AS score
      FROM builder_profiles b
      LEFT JOIN projects p
        ON p.owner_wallet = b.address
       AND p.approved = true
       AND p.live = true
      WHERE b.claimed_at  IS NOT NULL
        AND b.display_name IS NOT NULL AND LENGTH(TRIM(b.display_name)) >= 2
        AND b.bio          IS NOT NULL AND LENGTH(TRIM(b.bio))          >= 30
        AND b.avatar_url   IS NOT NULL AND LENGTH(TRIM(b.avatar_url))   > 0
        AND (
              (b.twitter  IS NOT NULL AND LENGTH(TRIM(b.twitter))  > 0)
           OR (b.github   IS NOT NULL AND LENGTH(TRIM(b.github))   > 0)
           OR (b.website  IS NOT NULL AND LENGTH(TRIM(b.website))  > 0)
           OR (b.telegram IS NOT NULL AND LENGTH(TRIM(b.telegram)) > 0)
        )
      GROUP BY
        b.address, b.display_name, b.bio, b.avatar_url,
        b.twitter, b.github, b.website, b.verified, b.claimed_at
      ORDER BY
        score       DESC,  -- weighted composite: verified + projects + reach
        b.claimed_at ASC   -- ties go to the earlier builder (veteran status)
    `)

    return NextResponse.json({ builders: res.rows }, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    })
  } catch (err) {
    console.error("[Builders GET]", err)
    return NextResponse.json({ builders: [] })
  }
}
