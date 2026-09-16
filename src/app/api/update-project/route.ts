import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const ALLOWED = ["tagline", "description", "website", "twitter", "github", "discord", "contract", "color", "city", "country", "founder_social", "logo_url"]
const ALLOWED_ARRAY = ["contracts"]

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "project-update", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const { token, slug, wallet, updates } = await req.json()

    if (!slug || !updates) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 })
    }

    let projectId: number | null = null
    let projectRow: any = null

    // Auth path A: magic-link token from the founder activation email
    if (token) {
      const result = await pool.query(
        `SELECT id, claim_token_expires FROM projects
         WHERE (slug = $1 OR id::text = $1) AND claim_token = $2`,
        [slug, token]
      )
      if (result.rows.length > 0 && new Date(result.rows[0].claim_token_expires) >= new Date()) {
        projectId = result.rows[0].id
      }
    }

    // Auth path B: signed-in wallet that actually owns this project.
    // Session cookie required — previously a bare wallet param was enough,
    // which let anyone with the owner address spam pending_updates.
    if (!projectId && wallet) {
      const sess = getSession(req)
      const lower = wallet.toLowerCase()
      if (!sess || sess.addr !== lower) {
        return NextResponse.json({ error: "Sign in with the project owner wallet to edit" }, { status: 401 })
      }
      const result = await pool.query(
        `SELECT id FROM projects WHERE (slug = $1 OR id::text = $1) AND owner_wallet = $2`,
        [slug, lower]
      )
      if (result.rows.length > 0) {
        projectId = result.rows[0].id
      }
    }

    if (!projectId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    // Get current project values
    const current = await pool.query(
      `SELECT tagline, description, website, twitter, github, discord, contract, contracts, color, city, country, founder_social FROM projects WHERE id = $1`,
      [projectId]
    )
    projectRow = current.rows[0]

    // Write each changed field to pending_updates
    let changeCount = 0
    for (const [key, value] of Object.entries(updates)) {
      // Handle array fields (contracts)
      if (ALLOWED_ARRAY.includes(key) && Array.isArray(value)) {
        const newArr = (value as string[]).map(c => c.trim()).filter(Boolean)
        const oldArr = Array.isArray(projectRow[key]) ? projectRow[key] : []
        if (JSON.stringify(newArr.sort()) === JSON.stringify([...oldArr].sort())) continue
        await pool.query(
          `UPDATE projects SET contracts = $1 WHERE id = $2`,
          [newArr, projectId]
        )
        changeCount++
        continue
      }
      if (!ALLOWED.includes(key) || typeof value !== "string") continue
      const newVal = (value as string).trim()
      const oldVal = projectRow[key] || ""
      if (newVal === oldVal) continue

      await pool.query(
        `INSERT INTO pending_updates (project_id, field, old_value, new_value)
         VALUES ($1, $2, $3, $4)`,
        [projectId, key, oldVal, newVal]
      )
      changeCount++
    }

    if (changeCount === 0) {
      return NextResponse.json({ success: true, message: "No changes detected" })
    }

    return NextResponse.json({ 
      success: true, 
      pending: true,
      message: `${changeCount} change${changeCount > 1 ? "s" : ""} submitted for review. Updates will appear after approval.`
    })
  } catch (err) {
    console.error("[Update Project]", err)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
