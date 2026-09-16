// src/app/api/cron/forex-refresh/route.ts
//
// Daily refresh of forex rates for non-USD-pegged stablecoins.
//
// Source: European Central Bank reference rates, published daily as a
// tiny XML file at https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml.
// ECB is the public-utility standard for FX transparency — no API key,
// no rate limit, and every analyst already trusts it.
//
// ECB quotes prices as "1 EUR = X target" (target_per_EUR). We convert
// to "1 target = Y USD" by combining each rate with the EUR/USD pair:
//
//   target_per_EUR = rate[target]                       (from ECB)
//   USD_per_EUR    = rate['USD']                        (from ECB)
//   USD_per_target = USD_per_EUR / target_per_EUR
//
// For EUR itself: USD_per_EUR is rate['USD'] directly.
// For USD: hardcoded 1.0.
//
// We only refresh currencies that are actually pegged-to by an active
// stablecoin — no point fetching JPY when no JPY stablecoin exists yet.

import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return req.headers.get("authorization") === `Bearer ${expected}`
}

// Parse ECB's XML format. Each <Cube currency="X" rate="Y" /> entry means
// 1 EUR = Y X. We only need the inner-most Cube elements that carry both
// `currency` and `rate` attributes — a tiny regex over the response body
// is more reliable than pulling in an XML parser.
function parseEcbRates(xml: string): Map<string, number> {
  const out = new Map<string, number>()
  // ECB serializes with single quotes; some mirrors use double. Accept both.
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const cur = m[1]
    const rate = Number(m[2])
    if (Number.isFinite(rate) && rate > 0) out.set(cur, rate)
  }
  return out
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const stats = {
    currencies_required: 0,
    currencies_updated: 0,
    currencies_missing: [] as string[],
    ecb_published_for: "" as string,
    source: ECB_URL,
    elapsedMs: 0,
  }
  const startedAt = Date.now()
  const client = await pool.connect()

  try {
    // Which non-USD currencies do we actually need rates for? Pull from the
    // active stablecoin registry. If none, we still refresh USD = 1.0 so the
    // drift cron's "forex_stale" check doesn't fire on the synthetic row.
    const needRes = await client.query<{ peg_currency: string }>(
      `SELECT DISTINCT peg_currency FROM stablecoins
       WHERE active = true AND peg_currency <> 'USD'`,
    )
    const needed = needRes.rows.map(r => r.peg_currency)
    stats.currencies_required = needed.length

    // Hardcoded USD anchor — always insert today's USD=1.0 row.
    await client.query(
      `INSERT INTO forex_rates (currency, effective_date, rate_to_usd, source)
       VALUES ('USD', CURRENT_DATE, 1.0, 'hardcoded')
       ON CONFLICT (currency, effective_date) DO UPDATE SET
         rate_to_usd = EXCLUDED.rate_to_usd,
         source      = EXCLUDED.source,
         fetched_at  = NOW()`,
    )
    stats.currencies_updated++

    if (needed.length === 0) {
      stats.elapsedMs = Date.now() - startedAt
      // Resolve any open forex_stale alerts that no longer apply.
      await client.query(
        `UPDATE indexer_alerts SET resolved_at = NOW()
         WHERE kind = 'forex_stale' AND resolved_at IS NULL`,
      )
      return NextResponse.json({
        ok: true,
        reason: "no_non_usd_stables",
        ...stats,
      })
    }

    // Fetch ECB rates. ECB sends back ~600 bytes of XML; cheap.
    let xml: string
    try {
      const r = await fetch(ECB_URL, {
        headers: { "User-Agent": "Arcat/1.0 (forex-refresh)" },
        cache: "no-store",
      })
      if (!r.ok) throw new Error(`ECB returned ${r.status}`)
      xml = await r.text()
    } catch (e: any) {
      await client.query(
        `INSERT INTO indexer_alerts (kind, severity, message, details)
         VALUES ('forex_fetch_error', 'critical', $1, $2::jsonb)`,
        [`ECB fetch failed: ${e?.message || e}`, JSON.stringify({ url: ECB_URL })],
      )
      stats.elapsedMs = Date.now() - startedAt
      return NextResponse.json({ ok: false, error: "ECB unreachable", ...stats }, { status: 502 })
    }

    // ECB publishes <Cube time='YYYY-MM-DD'> (single quotes) wrapping the day's rates.
    const tsMatch = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/)
    if (tsMatch) stats.ecb_published_for = tsMatch[1]
    const effectiveDate = stats.ecb_published_for || new Date().toISOString().slice(0, 10)

    const ecbRates = parseEcbRates(xml)  // target_per_EUR
    const usdPerEur = ecbRates.get("USD")
    if (!usdPerEur) {
      throw new Error("ECB response did not include USD/EUR rate")
    }

    for (const cur of needed) {
      let usdPerTarget: number | null = null
      if (cur === "EUR") {
        usdPerTarget = usdPerEur
      } else {
        const tgtPerEur = ecbRates.get(cur)
        if (tgtPerEur && tgtPerEur > 0) {
          usdPerTarget = usdPerEur / tgtPerEur
        }
      }

      if (usdPerTarget == null || !Number.isFinite(usdPerTarget)) {
        stats.currencies_missing.push(cur)
        await client.query(
          `INSERT INTO indexer_alerts (kind, severity, message, details)
           VALUES ('forex_currency_missing', 'warning', $1, $2::jsonb)`,
          [`ECB did not publish a rate for ${cur} — non-USD stablecoins pegged to it will use the most recent prior rate.`,
           JSON.stringify({ currency: cur, ecb_date: effectiveDate })],
        )
        continue
      }

      await client.query(
        `INSERT INTO forex_rates (currency, effective_date, rate_to_usd, source)
         VALUES ($1, $2::date, $3::numeric, 'ecb')
         ON CONFLICT (currency, effective_date) DO UPDATE SET
           rate_to_usd = EXCLUDED.rate_to_usd,
           source      = EXCLUDED.source,
           fetched_at  = NOW()`,
        [cur, effectiveDate, usdPerTarget.toFixed(8)],
      )
      stats.currencies_updated++
    }

    // Resolve any open forex_stale alerts that covered currencies we just
    // freshened. (Mass-resolve is fine — the drift cron will re-fire if
    // anything actually still stale.)
    await client.query(
      `UPDATE indexer_alerts SET resolved_at = NOW()
       WHERE kind IN ('forex_stale', 'forex_currency_missing') AND resolved_at IS NULL`,
    )

    stats.elapsedMs = Date.now() - startedAt
    return NextResponse.json({ ok: true, ...stats })
  } catch (e: any) {
    stats.elapsedMs = Date.now() - startedAt
    console.error("[forex-refresh] fatal:", e)
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), ...stats },
      { status: 500 },
    )
  } finally {
    client.release()
  }
}
