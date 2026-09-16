export const runtime = "nodejs"
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

function readPassword(req: NextRequest): string {
  const auth = req.headers.get("authorization") || ""
  return auth.startsWith("Bearer ") ? auth.slice(7) : ""
}

// CSV-safe: escape quotes, wrap fields that contain commas/quotes/newlines
function csv(val: unknown): string {
  if (val === null || val === undefined) return ""
  const s = String(val)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(req: NextRequest) {
  if (!checkAuth(readPassword(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Only export projects with an on-chain contract — Arc team is validating
    // contracts, not curated reference entries (Aave, Coinbase, etc).
    const res = await pool.query(`
      SELECT name, website, twitter, contract, contracts
      FROM projects
      WHERE approved = true
        AND live     = true
        AND (
          (contract IS NOT NULL AND LENGTH(TRIM(contract)) > 0)
          OR (contracts IS NOT NULL AND array_length(contracts, 1) > 0)
        )
      ORDER BY name
    `)

    // Human-readable headers for a more spacious feel in Excel/Sheets.
    const header = ["Project", "Contract Address", "Website", "X / Twitter"]

    // Match any valid Ethereum-style address embedded anywhere in the cell.
    // Some founders pasted things like "lunex token: 0xABC..." or wrapped the
    // address in backticks — this extracts the real address(es) and skips
    // anything that doesn't contain one (e.g. literal "jakarta").
    const ADDR_RE = /0x[a-fA-F0-9]{40}/g

    function extractAddrs(raw: unknown): string[] {
      if (!raw) return []
      const matches = String(raw).match(ADDR_RE)
      return matches ? matches.map(a => a.toLowerCase()) : []
    }

    function normalizeHandle(raw: string | null): string {
      if (!raw) return ""
      let h = String(raw).trim()
      if (!h) return ""
      const url = h.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i)
      if (url) h = url[1]
      h = h.replace(/^@+/, "").trim()
      return h ? "@" + h : ""
    }

    function normalizeWebsite(raw: string | null): string {
      if (!raw) return ""
      const w = String(raw).trim()
      if (!w) return ""
      // Add https:// if it's a bare domain, otherwise leave it
      return /^https?:\/\//i.test(w) ? w : "https://" + w
    }

    const rows: string[] = []
    for (const r of res.rows) {
      const x = normalizeHandle(r.twitter)
      const w = normalizeWebsite(r.website)
      const seen = new Set<string>()
      const addrs: string[] = []
      // Collect addresses from both the primary contract field and the extras array
      for (const a of extractAddrs(r.contract))  if (!seen.has(a)) { seen.add(a); addrs.push(a) }
      if (Array.isArray(r.contracts)) {
        for (const c of r.contracts) {
          for (const a of extractAddrs(c)) if (!seen.has(a)) { seen.add(a); addrs.push(a) }
        }
      }
      // One row per address — projects with no recoverable address are dropped
      for (const addr of addrs) {
        rows.push([r.name, addr, w, x].map(csv).join(","))
      }
    }

    const body = [header.join(","), ...rows].join("\n") + "\n"
    const filename = `arcat-projects-${new Date().toISOString().slice(0, 10)}.csv`

    return new NextResponse(body, {
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control":       "no-store",
      },
    })
  } catch (e) {
    console.error("[admin/export-projects]", e)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
