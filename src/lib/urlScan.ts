import { getPool } from "@/lib/dbPool"
// src/lib/urlScan.ts
//
// URL reputation via VirusTotal v3 — the trust layer's second opinion on
// founder-submitted URLs (project websites, campaign app URLs), alongside
// trustEngine's phishing-list check.
//
// Design:
//   - scanUrl(url)  fetches VT's existing report for the URL (GET by url-id).
//     If VT has never seen it, we submit it for analysis and record "queued";
//     the next scan pass picks up the finished verdict.
//   - Results are cached in the url_scans table. Admin views read the cache —
//     never VT directly — so the panel stays fast and we respect VT's free
//     tier (4 requests/minute). Fresh scans happen fire-and-forget at
//     submission time and in small batches on the trust-recheck cron.
//   - No VIRUSTOTAL_API_KEY → graceful no-op: verdict "no_key" so the admin
//     UI can say "scanning not configured" instead of lying.


const pool = getPool()

export interface UrlScan {
  url: string
  verdict: "clean" | "flagged" | "queued" | "error" | "no_key"
  malicious: number
  suspicious: number
  total_engines: number
  scanned_at: string
}

let tableReady = false
async function ensureTable() {
  if (tableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_scans (
      url           TEXT PRIMARY KEY,
      verdict       TEXT NOT NULL,
      malicious     INT DEFAULT 0,
      suspicious    INT DEFAULT 0,
      total_engines INT DEFAULT 0,
      scanned_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  tableReady = true
}

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    return u.toString()
  } catch { return null }
}

// VT v3 identifies a URL by unpadded base64url of the exact URL string.
function vtUrlId(url: string): string {
  return Buffer.from(url).toString("base64url").replace(/=+$/, "")
}

async function upsert(url: string, verdict: UrlScan["verdict"], malicious = 0, suspicious = 0, total = 0) {
  await ensureTable()
  await pool.query(
    `INSERT INTO url_scans (url, verdict, malicious, suspicious, total_engines, scanned_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (url) DO UPDATE SET
       verdict = $2, malicious = $3, suspicious = $4, total_engines = $5, scanned_at = NOW()`,
    [url, verdict, malicious, suspicious, total],
  )
}

/**
 * Scan one URL against VirusTotal and cache the result.
 * Never throws — a scanner outage must never break a submission flow.
 */
export async function scanUrl(rawUrl: string | null | undefined): Promise<void> {
  const url = rawUrl ? normalizeUrl(rawUrl) : null
  if (!url) return
  const key = process.env.VIRUSTOTAL_API_KEY
  try {
    if (!key) { await upsert(url, "no_key"); return }

    const rep = await fetch(`https://www.virustotal.com/api/v3/urls/${vtUrlId(url)}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(15_000),
    })

    if (rep.status === 404) {
      // VT has never analyzed this URL — submit it, pick the verdict up later.
      await fetch("https://www.virustotal.com/api/v3/urls", {
        method: "POST",
        headers: { "x-apikey": key, "Content-Type": "application/x-www-form-urlencoded" },
        body: `url=${encodeURIComponent(url)}`,
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {})
      await upsert(url, "queued")
      return
    }
    if (!rep.ok) { await upsert(url, "error"); return }

    const data = await rep.json()
    const stats = data?.data?.attributes?.last_analysis_stats
    if (!stats) { await upsert(url, "queued"); return }

    const malicious  = Number(stats.malicious  ?? 0)
    const suspicious = Number(stats.suspicious ?? 0)
    const total = ["malicious", "suspicious", "harmless", "undetected"]
      .reduce((s, k) => s + Number(stats[k] ?? 0), 0)
    await upsert(url, malicious + suspicious > 0 ? "flagged" : "clean", malicious, suspicious, total)
  } catch (e) {
    console.error("[urlScan]", url, (e as Error)?.message)
    try { await upsert(url, "error") } catch {}
  }
}

/**
 * Re-scan stale or unresolved entries in small batches — called from the
 * trust-recheck cron. VT free tier allows 4 req/min, so default batch is 4.
 */
/**
 * One rotation step for the scheduled scanner.
 *
 * VirusTotal's free tier allows 4 requests/minute and 500/day, so this can
 * never sweep everything at once. Instead it takes the most overdue handful
 * each run and rotates through the whole directory over time:
 *
 *   1. live listings whose website has never been scanned  (biggest blind spot)
 *   2. scans stuck on queued/error, or older than 7 days
 *
 * At a batch of 4 every 15 minutes that is ~384 checks/day, comfortably under
 * the daily cap and leaving headroom for manual rescans from the admin panel.
 */
export async function scanNextBatch(batch = 4): Promise<{ scanned: number; source: string }> {
  const key = process.env.VIRUSTOTAL_API_KEY
  if (!key) return { scanned: 0, source: "no_key" }
  await ensureTable()

  const fresh = await pool.query(
    `SELECT p.website AS url
       FROM projects p
      WHERE p.approved AND p.live AND p.website IS NOT NULL AND p.website <> ''
        AND NOT EXISTS (SELECT 1 FROM url_scans s WHERE s.url = p.website)
      ORDER BY p.created_at DESC
      LIMIT $1`,
    [batch],
  )
  if (fresh.rows.length) {
    for (const row of fresh.rows) await scanUrl(row.url)
    return { scanned: fresh.rows.length, source: "never_scanned" }
  }

  const n = await rescanStale(batch)
  return { scanned: n, source: "stale" }
}

export async function rescanStale(batch = 4): Promise<number> {
  const key = process.env.VIRUSTOTAL_API_KEY
  if (!key) return 0
  await ensureTable()
  const stale = await pool.query(
    `SELECT url FROM url_scans
     WHERE verdict IN ('queued', 'error', 'no_key')
        OR scanned_at < NOW() - INTERVAL '7 days'
     ORDER BY scanned_at ASC
     LIMIT $1`,
    [batch],
  )
  for (const row of stale.rows) await scanUrl(row.url)
  return stale.rows.length
}
