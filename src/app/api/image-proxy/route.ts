import { NextRequest, NextResponse } from "next/server"

// Use edge runtime — faster cold starts, no 10s serverless timeout on Vercel
export const runtime = "edge"

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")
  if (!url) return new NextResponse("Missing url", { status: 400 })

  // Only allow imgbb and known image hosts — security guard
  const allowed = [
    "i.ibb.co",
    "ibb.co",
    "blob.vercel-storage.com",
    "assets.coingecko.com",
    "arcat.app",
    "logo.clearbit.com",
    "icon.horse",
  ]
  try {
    const parsed = new URL(url)
    // Reject anything that isn't http/https — blocks file:// data:// javascript:// etc
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new NextResponse("Protocol not allowed", { status: 403 })
    }
    const hostname = parsed.hostname.toLowerCase()
    // Exact match or true subdomain — `endsWith("ibb.co")` alone matched evil-ibb.co
    const ok = allowed.some(h => hostname === h || hostname.endsWith("." + h))
    if (!ok) {
      return new NextResponse("Domain not allowed", { status: 403 })
    }
  } catch {
    return new NextResponse("Invalid URL", { status: 400 })
  }

  // 1x1 transparent PNG — served on any upstream failure so the browser shows
  // a blank pixel instead of a broken-image icon, and (crucially) so we return
  // 200 not 5xx. A rate-limited imgbb was making this route emit a 502 per
  // screenshot load, which tripped Vercel's error-spike alerting (56 in 5 min).
  const fallbackPixel = () => {
    const binary = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    )
    return new NextResponse(binary, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60" },
    })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://ibb.co/",
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
      },
    })

    clearTimeout(timeout)

    // Defense-in-depth: fetch follows redirects by default, so an allowed host
    // could 3xx us toward an internal address (e.g. cloud metadata). Re-validate
    // the FINAL url's host+protocol against the same allowlist before trusting it.
    try {
      const finalUrl   = new URL(res.url || url)
      const finalHost  = finalUrl.hostname.toLowerCase()
      const finalOk    = allowed.some(h => finalHost === h || finalHost.endsWith("." + h))
      if (!finalOk || (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:")) {
        console.error("[image-proxy] redirect to disallowed host", res.url)
        return fallbackPixel()
      }
    } catch {
      return fallbackPixel()
    }

    if (!res.ok) {
      console.error("[image-proxy] upstream", res.status, url)
      return fallbackPixel()
    }

    const contentType = res.headers.get("content-type") || "image/jpeg"
    // Only ever serve actual images — never HTML/JS/etc. This stops the proxy
    // being used to launder arbitrary (non-image) content through our domain,
    // which is exactly what gets a domain onto spam/abuse blocklists.
    if (!contentType.toLowerCase().startsWith("image/")) {
      console.error("[image-proxy] blocked non-image content-type", contentType, url)
      return fallbackPixel()
    }
    const buffer = await res.arrayBuffer()

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        // Cache in the visitor's browser too (max-age), not just the CDN (s-maxage),
        // so logos/avatars don't re-hit Vercel on every page they open. Each logo URL
        // is unique per upload, so a changed logo = a new URL = a fresh fetch.
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[image-proxy] failed:", url, msg)
    return fallbackPixel()
  }
}