// src/app/api/cron/trust-recheck/route.ts
//
// Daily trust WATCHDOG. Refreshes each project's ADVISORY profile (contract +
// website checks), AUTO-REDS only on a confirmed-bad signal (website on the scam
// list), and AUTO-MANAGES the objective "Vetted" tier (all contracts source-
// verified + no risk). It never sets Claimed/recognition — Claimed is set when a
// founder claims, recognition is granted by an admin. On a risk TRANSITION it
// writes on-chain: revoke when newly flagged, re-attest when cleared (env-gated).

export const runtime = "nodejs"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { loadPhishingList, hostOf, checkWebsite, analyzeContract, assessProject, type ContractRow } from "@/lib/trustEngine"
import { attestOnChain, revokeOnChain, subjectFor } from "@/lib/registry"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return req.headers.get("authorization") === `Bearer ${expected}`
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const list = await loadPhishingList()

    // Oldest-checked first so coverage rotates across runs under the time cap.
    const projects = (await pool.query(
      `SELECT id, slug, website, trust_level, recognition, trust_profile, established, caution_reviewed, contract, contracts
         FROM projects WHERE approved AND live
         ORDER BY trust_updated_at ASC NULLS FIRST`
    )).rows

    // All non-revoked contracts, grouped by project (one query, not N).
    const pc = (await pool.query(
      `SELECT project_id, address, role, (verified_at IS NOT NULL) AS verified
         FROM project_contracts WHERE revoked_at IS NULL`
    )).rows
    const byProject = new Map<number, ContractRow[]>()
    for (const r of pc) {
      const arr = byProject.get(r.project_id) || []
      arr.push({ address: r.address, role: r.role, verified: r.verified })
      byProject.set(r.project_id, arr)
    }

    const summary: any = { checked: 0, flagged: 0, newlyFlagged: 0, cleared: 0, deEstablished: 0, errors: 0, timedOut: false }
    const started = Date.now()
    const TIME_CAP = 200_000 // stay well under the 300s function limit; finish the rest next run

    for (const p of projects) {
      if (Date.now() - started > TIME_CAP) { summary.timedOut = true; break }
      try {
        // Scan EVERY contract the project lists — registered (proven) + primary +
        // extras, deduped. Flagging risk needs no ownership; we read public code.
        const regs = byProject.get(p.id) || []
        const seen = new Set(regs.map(c => c.address.toLowerCase()))
        const allContracts: ContractRow[] = [...regs]
        const addOne = (addr: any, role: string) => {
          const a = String(addr || "").trim()
          if (/^0x[a-fA-F0-9]{40}$/.test(a) && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); allContracts.push({ address: a, role, verified: false }) }
        }
        addOne(p.contract, "primary")
        for (const e of (Array.isArray(p.contracts) ? p.contracts : [])) addOne(e, "extra")

        const analyzed = []
        for (const c of allContracts) analyzed.push(await analyzeContract(c))

        const websiteVerdict = checkWebsite(hostOf(p.website), list)
        const { hardRisk, profile } = assessProject({ websiteVerdict, contracts: analyzed })

        // Store the ADVISORY profile. Trust level is never auto-set here (Claimed =
        // on claim, Verified = admin audit, recognition = admin). Established is
        // ADMIN-GRANTED against an on-chain eligibility check — the watchdog only
        // AUTO-REVOKES it if the project later becomes hard-risk.
        // Review state: a NEW caution lands unreviewed (so it surfaces to admin);
        // a persisting one keeps the admin's prior acknowledgement; no caution clears it.
        const newCaution  = profile.caution === true
        const prevCaution = p.trust_profile?.caution === true
        const reviewedNext = newCaution ? (prevCaution ? !!p.caution_reviewed : false) : false

        if (hardRisk && p.established) {
          await pool.query(`UPDATE projects SET trust_profile = $1::jsonb, established = false, caution_reviewed = $2, trust_updated_at = NOW() WHERE id = $3`, [JSON.stringify(profile), reviewedNext, p.id])
          summary.deEstablished++
        } else {
          await pool.query(`UPDATE projects SET trust_profile = $1::jsonb, caution_reviewed = $2, trust_updated_at = NOW() WHERE id = $3`, [JSON.stringify(profile), reviewedNext, p.id])
        }
        summary.checked++
        if (hardRisk) summary.flagged++

        // On-chain writes only on a risk TRANSITION (avoids daily mass writes).
        // Subject = the proven contract if registered, else the project's synthetic id.
        const prevRisk = p.trust_profile?.hard_risk === true
        const subject = subjectFor({ provenContract: regs[0]?.address, slug: p.slug })
        if (subject) {
          if (hardRisk && !prevRisk) { await revokeOnChain(subject).catch(() => {}); summary.newlyFlagged++ }
          else if (!hardRisk && prevRisk) { await attestOnChain(subject, p.trust_level, p.recognition, "ecosystem/" + (p.slug || ""), !!p.established).catch(() => {}); summary.cleared++ }
        }
      } catch {
        summary.errors++
      }
    }

    return NextResponse.json({ ok: true, ...summary })
  } catch (e: any) {
    console.error("[trust-recheck]", e?.message || e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
