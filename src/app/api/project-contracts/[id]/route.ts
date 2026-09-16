// src/app/api/project-contracts/[id]/route.ts
//
// PATCH  — founder edits non-material fields (label only, for now) directly.
//          Material edits (role, volume config, start_block) go through the
//          existing /challenge → sign flow because they change what was
//          attested to in the original deployer signature. This file
//          accepts cosmetic edits only; the founder UI routes material
//          edits back through POST /api/project-contracts after re-signing.
//
// DELETE — founder unregisters a tracked contract. Soft-deletes (sets
//          revoked_at) so audit history is preserved and the indexer simply
//          stops counting it on the next tick.

import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const idNum = Number(id)
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }
  const sess = getSession(req)
  if (!sess) return NextResponse.json({ error: "Sign in required" }, { status: 401 })

  const r = await pool.query(
    `SELECT pc.id, pc.label, pc.deployer_address, p.owner_wallet
     FROM project_contracts pc
     JOIN projects p ON p.id = pc.project_id
     WHERE pc.id = $1`,
    [idNum],
  )
  if (r.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const row = r.rows[0]
  const owner    = (row.owner_wallet || "").toLowerCase()
  const deployer = (row.deployer_address || "").toLowerCase()
  if (sess.addr !== owner && sess.addr !== deployer) {
    return NextResponse.json(
      { error: "Only the project owner or the contract's deployer can edit." },
      { status: 403 },
    )
  }

  try {
    const body = await req.json()

    // Cosmetic-only fields the founder can edit without re-signing.
    // Anything else (role, volume_method, event_signature, amount_arg,
    // stablecoin_id, start_block) requires the founder to re-issue a
    // challenge + re-sign — they would call POST /api/project-contracts again.
    const COSMETIC = ["label"]
    const editable: Record<string, any> = {}
    for (const k of COSMETIC) {
      if (k in body) editable[k] = body[k]
    }
    // Surface a clear error if the founder tried to PATCH a material field
    for (const k of Object.keys(body)) {
      if (!COSMETIC.includes(k) && k !== "id") {
        return NextResponse.json({
          error: `'${k}' is a material field. Re-register through the signing flow to change it.`,
        }, { status: 400 })
      }
    }
    if (Object.keys(editable).length === 0) {
      return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 })
    }

    const labelVal = editable.label != null ? String(editable.label).slice(0, 80) : null
    await pool.query(
      `UPDATE project_contracts SET label = $2 WHERE id = $1`,
      [idNum, labelVal],
    )
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error("[project-contracts PATCH]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const idNum = Number(id)
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const sess = getSession(req)
  if (!sess) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 })
  }

  // Allow the project owner to revoke. Mirrors the ownership check used by
  // /api/update-project. We also allow the original deployer wallet (the one
  // that signed the registration) so multi-owner teams aren't locked out.
  const r = await pool.query(
    `SELECT pc.id, pc.deployer_address, p.owner_wallet
     FROM project_contracts pc
     JOIN projects p ON p.id = pc.project_id
     WHERE pc.id = $1`,
    [idNum],
  )
  if (r.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const row = r.rows[0]
  const owner    = (row.owner_wallet || "").toLowerCase()
  const deployer = (row.deployer_address || "").toLowerCase()
  if (sess.addr !== owner && sess.addr !== deployer) {
    return NextResponse.json(
      { error: "Only the project owner or the contract's deployer can revoke." },
      { status: 403 },
    )
  }

  await pool.query(
    `UPDATE project_contracts
     SET revoked_at = NOW(),
         revoke_reason = COALESCE(revoke_reason, 'founder-removed')
     WHERE id = $1`,
    [idNum],
  )

  // If this was the last live contract for the project, fully clear the
  // materialized metrics + flip tracking off so /ecosystem and the public
  // API don't keep showing stale numbers.
  const projectId = r.rows[0]?.id
    ? (await pool.query(
        `SELECT project_id FROM project_contracts WHERE id = $1`,
        [idNum],
      )).rows[0]?.project_id
    : null
  if (projectId) {
    await pool.query(
      `UPDATE projects p SET
         tvl_tracking_enabled    = false,
         tvl_usd_e6              = NULL,
         tvl_ath_usd_e6          = NULL,
         tvl_ath_block           = NULL,
         tvl_ath_at              = NULL,
         revenue_cum_usd_e6      = NULL,
         revenue_ath_day_usd_e6  = NULL,
         revenue_ath_day         = NULL,
         volume_cum_usd_e6       = NULL,
         volume_ath_day_usd_e6   = NULL,
         volume_ath_day          = NULL
       WHERE p.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM project_contracts pc
           WHERE pc.project_id = p.id
             AND pc.verified_at IS NOT NULL
             AND pc.revoked_at IS NULL
         )`,
      [projectId],
    )
  }

  return NextResponse.json({ success: true })
}
