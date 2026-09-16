// src/app/api/trials/[id]/feedback.csv/route.ts
//
// Founder CSV export of a campaign's feedback — one row per submission, with
// the campaign's review questions and task proofs flattened into columns so
// it opens clean in Excel/Sheets.
//
// Access: the requesting wallet must be the campaign creator (same check the
// creator views use). The underlying rows are the same data the campaign JSON
// already serves — this endpoint is formatting, not new exposure.
//
// Fixed columns:
//   tester_wallet, submitted_at, status, contract_verified,
//   auto_score, builder_rating, quality_score, xp_earned
// Then one column per review question (its label), one per task proof.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"
import { getSession } from "@/lib/session"

const pool = getPool()

function csvEscape(v: unknown): string {
  if (v == null) return ""
  let s = String(v)
  // Spreadsheet-injection guard: a cell starting with = + - @ executes as a
  // formula in Excel/Sheets. Tester-written text is untrusted — neutralize it.
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const isNumeric = /^\d+$/.test(id)
  const whereClause = isNumeric ? "id = $1" : "slug = $1"
  const session = getSession(req)

  try {
    const campRes = await pool.query(
      `SELECT id, slug, title, creator_wallet, tasks, review_questions
       FROM campaigns WHERE ${whereClause} LIMIT 1`,
      [isNumeric ? Number(id) : id],
    )
    const camp = campRes.rows[0]
    if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    if (!session || camp.creator_wallet?.toLowerCase() !== session.addr) {
      return NextResponse.json({ error: "Only the signed-in campaign creator can export feedback" }, { status: 403 })
    }

    const questions: { id: string; label: string }[] = Array.isArray(camp.review_questions) ? camp.review_questions : []
    const tasks:     { id: string; title: string }[] = Array.isArray(camp.tasks) ? camp.tasks : []

    const rows = await pool.query(
      `SELECT tester_wallet, created_at, status, contract_verified,
              auto_score, builder_rating, quality_score, xp_earned,
              review_answers, task_proofs
       FROM campaign_completions WHERE campaign_id = $1
       ORDER BY created_at ASC LIMIT 2000`,
      [camp.id],
    )

    const header = [
      "tester_wallet", "submitted_at", "status", "contract_verified",
      "auto_score", "builder_rating", "quality_score", "xp_earned",
      ...questions.map(q => q.label),
      ...tasks.map(t => `proof: ${t.title}`),
    ]

    const lines = [header.map(csvEscape).join(",")]
    for (const r of rows.rows) {
      const answers: Record<string, unknown> = r.review_answers || {}
      const proofs:  Record<string, unknown> = r.task_proofs || {}
      lines.push([
        r.tester_wallet,
        r.created_at ? new Date(r.created_at).toISOString() : "",
        r.status,
        r.contract_verified ? "yes" : "no",
        r.auto_score ?? "",
        r.builder_rating ?? "",
        r.quality_score ?? "",
        r.xp_earned ?? "",
        ...questions.map(q => answers[q.id] ?? ""),
        ...tasks.map(t => proofs[t.id] ?? ""),
      ].map(csvEscape).join(","))
    }

    const filename = `${camp.slug || camp.id}-feedback.csv`
    // BOM so Excel parses UTF-8 (wallets, non-ASCII feedback) correctly.
    return new NextResponse("﻿" + lines.join("\r\n") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (e) {
    console.error("[feedback.csv]", (e as Error)?.message)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
