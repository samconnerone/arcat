// src/app/api/admin/tracked-contracts/route.ts
//
// Admin view + edit + revoke for every project_contracts row that's been
// registered via the founder deployer-signature flow. This is the
// "Tracked Contracts" tab — visibility + diagnostics + override, never
// pre-approval. The deployer-sig is the trust gate; admin reviews after.
//
// Endpoints:
//   GET   /api/admin/tracked-contracts          → full list with status + last error
//   PATCH /api/admin/tracked-contracts/[id]     → admin direct edit (lives in [id]/route.ts)
//   DELETE /api/admin/tracked-contracts/[id]    → admin revoke (lives in [id]/route.ts)

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
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

export async function GET(req: NextRequest) {
  if (!checkAuth(resolvePw(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Pull every project_contract that's currently live (verified, not revoked)
    // OR revoked recently (so admin can see history). Join projects for the slug
    // + name, stablecoins for the volume denomination symbol, and the latest
    // indexer_alerts row for this project so admin sees "last error" inline.
    const rows = await pool.query(`
      WITH last_alert AS (
        SELECT DISTINCT ON (project_id)
          project_id, kind, severity, message, created_at
        FROM indexer_alerts
        WHERE resolved_at IS NULL
        ORDER BY project_id, created_at DESC
      ),
      live_per_project AS (
        SELECT project_id, COUNT(*)::int AS live_count
        FROM project_contracts
        WHERE verified_at IS NOT NULL AND revoked_at IS NULL
        GROUP BY project_id
      )
      SELECT
        pc.id, pc.project_id, pc.address, pc.role, pc.label, pc.start_block,
        pc.deployer_address, pc.verified_at, pc.revoked_at, pc.revoke_reason,
        pc.created_at,
        pc.volume_method, pc.volume_event_signature, pc.volume_amount_arg,
        pc.volume_stablecoin_id,
        p.slug AS project_slug, p.name AS project_name,
        p.tvl_usd_e6::text         AS project_tvl_usd_e6,
        p.volume_cum_usd_e6::text  AS project_volume_cum_usd_e6,
        p.revenue_cum_usd_e6::text AS project_revenue_cum_usd_e6,
        p.tvl_last_indexed_at,
        s.symbol AS volume_stablecoin_symbol,
        la.kind AS last_alert_kind, la.severity AS last_alert_severity,
        la.message AS last_alert_message, la.created_at AS last_alert_at,
        (SELECT COUNT(*)::int FROM volume_events  WHERE contract_id = pc.id) AS volume_event_count,
        (SELECT COUNT(*)::int FROM revenue_events WHERE contract_id = pc.id) AS revenue_event_count
      FROM project_contracts pc
      JOIN projects p ON p.id = pc.project_id
      LEFT JOIN stablecoins s ON s.id = pc.volume_stablecoin_id
      LEFT JOIN last_alert la ON la.project_id = pc.project_id
      LEFT JOIN live_per_project lpp ON lpp.project_id = pc.project_id
      WHERE pc.verified_at IS NOT NULL
      ORDER BY
        CASE WHEN pc.revoked_at IS NULL THEN 0 ELSE 1 END,
        pc.created_at DESC
      LIMIT 500
    `)

    // For each row, derive a status pill:
    //   ✓ working        — event count > 0 OR (role=tvl AND tvl_last_indexed_at recent)
    //   ⏳ awaiting        — created < 10 min ago AND no events yet
    //   ⚠ errored         — last_alert is critical OR mentions this address
    //   🔇 quiet           — registered > 10 min ago, no events, no alerts
    //   ⏸ revoked          — revoked_at set
    const enriched = rows.rows.map(r => {
      const created = new Date(r.created_at).getTime()
      const ageMin = (Date.now() - created) / 60000
      const events = r.role === "volume" ? r.volume_event_count
                   : r.role === "revenue" ? r.revenue_event_count
                   : 0
      let status: "working" | "awaiting" | "errored" | "quiet" | "revoked" = "quiet"
      if (r.revoked_at) status = "revoked"
      else if (r.last_alert_severity === "critical") status = "errored"
      else if (r.role === "tvl") {
        const indexedAge = r.tvl_last_indexed_at
          ? (Date.now() - new Date(r.tvl_last_indexed_at).getTime()) / 60000
          : Infinity
        if (indexedAge < 15) status = "working"
        else if (ageMin < 10) status = "awaiting"
        else status = "quiet"
      } else {
        if (events > 0) status = "working"
        else if (ageMin < 10) status = "awaiting"
        else status = "quiet"
      }

      return {
        id: r.id,
        project_id: r.project_id,
        project_slug: r.project_slug,
        project_name: r.project_name,
        address: r.address,
        role: r.role,
        label: r.label,
        start_block: Number(r.start_block),
        deployer_address: r.deployer_address,
        verified_at: r.verified_at,
        revoked_at: r.revoked_at,
        revoke_reason: r.revoke_reason,
        created_at: r.created_at,
        volume: r.role === "volume" ? {
          method: r.volume_method,
          event_signature: r.volume_event_signature,
          amount_arg: r.volume_amount_arg,
          stablecoin_id: r.volume_stablecoin_id,
          stablecoin_symbol: r.volume_stablecoin_symbol,
          event_count: r.volume_event_count,
        } : null,
        revenue: r.role === "revenue" ? { event_count: r.revenue_event_count } : null,
        tvl: r.role === "tvl" ? {
          last_indexed_at: r.tvl_last_indexed_at,
          project_tvl_usd_e6: r.project_tvl_usd_e6,
        } : null,
        last_alert: r.last_alert_at ? {
          kind: r.last_alert_kind,
          severity: r.last_alert_severity,
          message: String(r.last_alert_message).slice(0, 200),
          created_at: r.last_alert_at,
        } : null,
        status,
      }
    })

    // Summary counts for the sidebar badge
    const counts = {
      total:    enriched.filter(r => !r.revoked_at).length,
      working:  enriched.filter(r => r.status === "working").length,
      errored:  enriched.filter(r => r.status === "errored").length,
      quiet:    enriched.filter(r => r.status === "quiet").length,
      awaiting: enriched.filter(r => r.status === "awaiting").length,
      revoked:  enriched.filter(r => r.status === "revoked").length,
    }

    return NextResponse.json({ contracts: enriched, counts })
  } catch (e: any) {
    console.error("[admin/tracked-contracts GET]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
