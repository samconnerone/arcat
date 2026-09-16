// src/app/api/tvl/[slug]/events.csv/route.ts
//
// Per-project CSV export of every revenue + volume event. One row per log;
// each row is independently verifiable by looking up the tx_hash on Arc.
//
// Streamed in chunks so a protocol with millions of events doesn't
// materialize the whole result set in memory. Vercel functions get a
// 4MB response cap, so the streaming is what makes very large projects
// downloadable too — we flush rows as they come off the DB cursor.
//
// Columns:
//   event_type       'revenue' | 'volume'
//   block_number
//   block_time       ISO 8601 UTC
//   tx_hash
//   log_index
//   contract_address  the tracked contract that emitted the event
//   from_address      revenue events only
//   stablecoin        the stablecoin symbol the amount is denominated in
//   amount_raw        the on-chain amount in token-native decimals
//   amount_usd        USD value at the day's forex rate (USD-pegged stables = raw/10^decimals)

import { NextRequest } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

function csvEscape(v: any): string {
  if (v == null) return ""
  const s = String(v)
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function usdStr(rawE6: string | null): string {
  if (rawE6 == null) return ""
  try { return (Number(BigInt(rawE6)) / 1e6).toFixed(6) } catch { return "" }
}

const HEADER = [
  "event_type", "block_number", "block_time", "tx_hash", "log_index",
  "contract_address", "from_address", "stablecoin",
  "amount_raw", "amount_usd",
].join(",") + "\n"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  // This route streams every recorded event for a project — 21MB for the
  // largest one. It is unlinked from the UI, so in practice only crawlers find
  // it, and an unlimited public dump on a 5-minute cache was the single biggest
  // consumer of the database egress budget. The cache below makes repeat reads
  // free; this limiter stops anything trying to bypass it with unique URLs.
  const { enforce } = await import("@/lib/ratelimit")
  const blocked = await enforce(req, "events-csv", { limit: 4, windowMs: 60 * 60_000 })
  if (blocked) return blocked

  const { slug } = await params

  // Resolve the project ID first so the streaming query doesn't have to JOIN.
  const proj = await pool.query<{ id: number; tvl_tracking_enabled: boolean; name: string }>(
    `SELECT id, tvl_tracking_enabled, name FROM projects
     WHERE (slug = $1 OR id::text = $1) AND approved = true AND live = true
     LIMIT 1`,
    [slug],
  )
  if (proj.rows.length === 0) {
    return new Response("Not found", { status: 404 })
  }
  if (!proj.rows[0].tvl_tracking_enabled) {
    return new Response("TVL tracking not enabled for this project", { status: 404 })
  }
  const projectId = proj.rows[0].id

  // Build the ReadableStream. We use the standard pg `client.query` rather
  // than pg-cursor since a pg cursor session needs more careful lifecycle
  // management and our row counts (≤ low six figures) fit comfortably.
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(HEADER))

      const client = await pool.connect()
      try {
        // UNION ALL across both event tables, ordered chronologically.
        // Joined to stablecoins for the symbol; to project_contracts for the
        // tracked-contract address.
        const q = await client.query(
          `SELECT * FROM (
             SELECT 'revenue'::text AS event_type,
                    r.block_number, r.block_time,
                    r.tx_hash, r.log_index,
                    pc.address AS contract_address,
                    r.from_address,
                    s.symbol AS stablecoin,
                    r.amount_raw::text AS amount_raw,
                    r.amount_usd_e6::text AS amount_usd_e6
             FROM revenue_events r
             JOIN project_contracts pc ON pc.id = r.contract_id
             JOIN stablecoins      s  ON s.id  = r.stablecoin_id
             WHERE r.project_id = $1
             UNION ALL
             SELECT 'volume'::text AS event_type,
                    v.block_number, v.block_time,
                    v.tx_hash, v.log_index,
                    pc.address AS contract_address,
                    NULL::text  AS from_address,
                    s.symbol AS stablecoin,
                    v.amount_raw::text AS amount_raw,
                    v.amount_usd_e6::text AS amount_usd_e6
             FROM volume_events v
             JOIN project_contracts pc ON pc.id = v.contract_id
             JOIN stablecoins      s  ON s.id  = v.stablecoin_id
             WHERE v.project_id = $1
           ) AS u
           ORDER BY u.block_number ASC, u.log_index ASC`,
          [projectId],
        )

        // Flush in small batches so memory pressure stays low even on
        // very large exports.
        let buf = ""
        for (const row of q.rows) {
          buf += [
            row.event_type,
            row.block_number,
            new Date(row.block_time).toISOString(),
            row.tx_hash,
            row.log_index,
            row.contract_address,
            row.from_address ?? "",
            row.stablecoin,
            row.amount_raw,
            usdStr(row.amount_usd_e6),
          ].map(csvEscape).join(",") + "\n"
          if (buf.length > 64 * 1024) {
            controller.enqueue(enc.encode(buf))
            buf = ""
          }
        }
        if (buf.length > 0) controller.enqueue(enc.encode(buf))
      } catch (e: any) {
        controller.enqueue(new TextEncoder().encode(`# error: ${e?.message || e}\n`))
      } finally {
        client.release()
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-events.csv"`,
      // Event history is append-only and verified against the chain, so a day
      // old is fine. At 5 minutes every crawler hit was a fresh 21MB read from
      // Postgres; at a day, the CDN answers repeats without touching the DB.
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
