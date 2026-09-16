// src/app/api/admin/tracked-contracts/[id]/route.ts
//
// PATCH  → admin direct edit of any field on a tracked contract. Logged
//          to ai_actions so the audit trail exists even though no on-chain
//          re-sign happens.
// DELETE → admin revoke (soft delete) — sets revoked_at, fires the same
//          materialization-reset path the founder-facing revoke uses.
//
// When material fields (role, volume_method, volume_event_signature,
// volume_amount_arg, volume_stablecoin_id, start_block) change, we also:
//   • delete the contract's existing volume_events / revenue_events
//   • reset the per-contract indexer cursor
// …so the next 5-min indexer tick re-scans from start_block with the new
// config and the cached values self-correct via the existing rollup query.

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { ethers } from "ethers"
import { canonicalEventSignature, dataArgTypes } from "@/lib/tvl"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""

function checkAuth(pw: string): boolean {
  if (!ADMIN_PASSWORD || !pw) return false
  const a = Buffer.from(pw)
  const b = Buffer.from(ADMIN_PASSWORD)
  return a.length === b.length && timingSafeEqual(a, b)
}

function resolvePw(req: NextRequest): string {
  const auth = req.headers.get("authorization") || ""
  return auth.startsWith("Bearer ") ? auth.slice(7) : ""
}

async function logAction(kind: string, contractId: number, before: any, after: any, error?: string) {
  try {
    await pool.query(
      `INSERT INTO ai_actions (kind, initiator, payload, status, error, completed_at)
       VALUES ($1, 'admin_confirmed', $2::jsonb, $3, $4, NOW())`,
      [kind, JSON.stringify({ contract_id: contractId, before, after }), error ? "failed" : "succeeded", error ?? null],
    )
  } catch { /* never fail an action because we couldn't log it */ }
}

const MATERIAL_FIELDS = ["role", "start_block", "volume_method", "volume_event_signature", "volume_amount_arg", "volume_stablecoin_id"] as const

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(resolvePw(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { id } = await params
  const idNum = Number(id)
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const editable: Record<string, any> = {}
    for (const k of ["label", "start_block", "role", "volume_method", "volume_event_signature", "volume_amount_arg", "volume_stablecoin_id"]) {
      if (k in body) editable[k] = body[k]
    }
    if (Object.keys(editable).length === 0) {
      return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 })
    }

    // Load existing row to detect what changed
    const prior = await pool.query(
      `SELECT * FROM project_contracts WHERE id = $1`,
      [idNum],
    )
    if (prior.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const before = prior.rows[0]

    // Validate role + volume config consistency
    const nextRole = "role" in editable ? editable.role : before.role
    if (!["tvl", "revenue", "treasury", "volume"].includes(nextRole)) {
      return NextResponse.json({ error: "role must be tvl, revenue, treasury, or volume" }, { status: 400 })
    }
    if (nextRole === "volume") {
      const nextMethod = "volume_method" in editable ? editable.volume_method : before.volume_method ?? "swap_event"
      if (!["swap_event", "outflow_transfer"].includes(nextMethod)) {
        return NextResponse.json({ error: "volume_method must be swap_event or outflow_transfer" }, { status: 400 })
      }
      const nextSc = "volume_stablecoin_id" in editable ? editable.volume_stablecoin_id : before.volume_stablecoin_id
      if (!Number.isFinite(Number(nextSc))) {
        return NextResponse.json({ error: "volume_stablecoin_id required for volume role" }, { status: 400 })
      }
      if (nextMethod === "swap_event") {
        const nextSig = "volume_event_signature" in editable ? editable.volume_event_signature : before.volume_event_signature
        if (!nextSig || !/^[A-Za-z_][A-Za-z0-9_]*\(.*\)$/.test(String(nextSig).trim())) {
          return NextResponse.json({ error: "swap_event method requires a valid event signature" }, { status: 400 })
        }
        const nextArg = "volume_amount_arg" in editable ? Number(editable.volume_amount_arg) : Number(before.volume_amount_arg ?? -1)
        const dataTypes = dataArgTypes(String(nextSig))
        if (!dataTypes.length || nextArg < 0 || nextArg >= dataTypes.length) {
          return NextResponse.json({ error: "amount_arg out of range for the event signature" }, { status: 400 })
        }
      }
    }

    // Detect material changes — these trigger a re-index
    const materialChanged = MATERIAL_FIELDS.some(f => f in editable && String(editable[f]) !== String((before as any)[f]))

    // Recompute the topic hash if signature changed
    let nextTopic: string | null | undefined = undefined
    if (nextRole === "volume" && ("volume_event_signature" in editable || "volume_method" in editable)) {
      const method = "volume_method" in editable ? editable.volume_method : before.volume_method ?? "swap_event"
      const sig = "volume_event_signature" in editable ? editable.volume_event_signature : before.volume_event_signature
      nextTopic = (method === "swap_event" && sig) ? ethers.id(canonicalEventSignature(String(sig))) : null
    }

    // Build the UPDATE — only set the fields the admin actually sent
    const sets: string[] = []
    const vals: any[] = [idNum]
    let i = 2
    for (const k of Object.keys(editable)) {
      sets.push(`${k} = $${i}`)
      vals.push(editable[k])
      i++
    }
    if (nextTopic !== undefined) {
      sets.push(`volume_event_topic = $${i}`)
      vals.push(nextTopic)
      i++
    }
    if (sets.length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
    }

    const updated = await pool.query(
      `UPDATE project_contracts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals,
    )
    const after = updated.rows[0]

    // Re-index trigger: wipe events + cursor for this contract so the next
    // 5-min cron tick rescans from start_block with the new config.
    if (materialChanged) {
      const cursorKind = `volume_${idNum}`
      await pool.query(`DELETE FROM volume_events  WHERE contract_id = $1`, [idNum])
      await pool.query(`DELETE FROM revenue_events WHERE contract_id = $1`, [idNum])
      await pool.query(`DELETE FROM volume_daily   WHERE project_id  = $1`, [before.project_id])
      await pool.query(`DELETE FROM revenue_daily  WHERE project_id  = $1`, [before.project_id])
      await pool.query(`DELETE FROM indexer_cursors WHERE kind = $1`, [cursorKind])
    }

    await logAction("contract_edit_admin", idNum, before, after)

    return NextResponse.json({
      success: true,
      contract: after,
      re_indexed: materialChanged,
    })
  } catch (e: any) {
    console.error("[admin/tracked-contracts PATCH]", e)
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(resolvePw(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { id } = await params
  const idNum = Number(id)
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    // Soft-revoke (audit history preserved)
    const r = await pool.query(
      `UPDATE project_contracts
       SET revoked_at = NOW(),
           revoke_reason = COALESCE(revoke_reason, 'admin-revoked')
       WHERE id = $1
       RETURNING id, project_id`,
      [idNum],
    )
    if (r.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const projectId = r.rows[0].project_id

    // If this was the project's last live contract, fully reset the cached
    // metrics (same pattern as the founder-facing revoke endpoint).
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

    await logAction("contract_revoke_admin", idNum, { project_id: projectId }, { revoked_at: new Date().toISOString() })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error("[admin/tracked-contracts DELETE]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
