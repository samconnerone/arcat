import { NextRequest, NextResponse } from "next/server"
import { rateLimit, getIp } from "@/lib/ratelimit"
import { put } from "@vercel/blob"

// 5 MB — anything larger is almost certainly not a profile picture or logo
const MAX_BYTES = 5 * 1024 * 1024
// Whitelist common image formats; reject everything else so abusers can't
// upload PDFs, executables, archives, or anything else to our Imgbb account
// SVG is included because project-logo uploads use it; note SVGs can carry
// JS (XSS risk) — Imgbb sanitizes most cases, but this is a follow-up to
// review separately if you ever serve SVGs from your own origin.
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml",
])
const ALLOWED_EXT  = /\.(jpe?g|png|webp|gif|svg)$/i

export async function POST(req: NextRequest) {
  // Rate limit: 40 uploads/hour/IP. Raised from 20 — active campaigns with
  // many testers (some behind shared NAT / mobile carriers / VPN) were
  // hitting the ceiling on legitimate proof screenshots.
  const rl = await rateLimit(`upload:${getIp(req)}`, 40, 3_600_000)
  if (!rl.allowed) {
    const mins = Math.ceil(rl.resetIn / 60000)
    return NextResponse.json(
      { error: `Too many uploads from your network. Try again in ~${mins} min, or use a different connection.` },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    )
  }

  let formData: FormData
  try { formData = await req.formData() }
  catch { return NextResponse.json({ error: "Couldn't read the upload — try again." }, { status: 400 }) }

  const file = formData.get("image") as File
  if (!file) return NextResponse.json({ error: "No image selected." }, { status: 400 })

  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return NextResponse.json({ error: `Image is ${mb} MB — max is 5 MB. Crop or compress it and try again.` }, { status: 413 })
  }
  // iPhone photos default to HEIC, which imgbb rejects. Screenshots are PNG —
  // call that out explicitly so confused users know the fix.
  if (!ALLOWED_MIME.has(file.type)) {
    const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || "")
    return NextResponse.json({
      error: isHeic
        ? "iPhone HEIC photos aren't supported. Take a screenshot (PNG) instead, or change your camera format to 'Most Compatible'."
        : "Only JPG, PNG, WebP, or GIF images are accepted. A screenshot (PNG) works best.",
    }, { status: 415 })
  }
  if (file.name && !ALLOWED_EXT.test(file.name)) {
    return NextResponse.json({ error: "That file isn't a supported image (JPG, PNG, WebP, GIF)." }, { status: 415 })
  }

  const bytes = await file.arrayBuffer()
  const safeName = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60)

  // ── Primary: Vercel Blob ──────────────────────────────────────────────────
  // Platform-native, no third-party rate caps. imgbb's free key gets throttled
  // at campaign scale (220+ testers uploading proof screenshots), which was
  // surfacing as "image host is busy". Blob scales with the deployment.
  // A random suffix keeps filenames unique so two testers' "screenshot.png"
  // don't collide.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const ext  = (safeName.match(/\.[a-z0-9]+$/i)?.[0] || ".png")
      const rand = Math.random().toString(36).slice(2, 10)
      const blob = await put(`uploads/${Date.now()}-${rand}${ext}`, bytes, {
        access: "public",
        contentType: file.type || "image/png",
        // Pass the token explicitly rather than relying on the SDK's import-time
        // env read — guarantees it resolves regardless of when the var is injected.
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      return NextResponse.json({ url: blob.url })
    } catch (e) {
      console.error("[upload] vercel blob failed, falling back to imgbb", e)
      // fall through to imgbb
    }
  }

  // ── Fallback: imgbb ───────────────────────────────────────────────────────
  if (!process.env.IMGBB_API_KEY) {
    return NextResponse.json({ error: "Image hosting isn't configured. Contact support." }, { status: 500 })
  }
  const base64 = Buffer.from(bytes).toString("base64")
  const body = new URLSearchParams()
  body.append("key", process.env.IMGBB_API_KEY)
  body.append("image", base64)
  body.append("name", safeName)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    const res  = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body, signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error("[upload] imgbb HTTP", res.status)
      return NextResponse.json({ error: "Image host is busy right now. Wait a few seconds and try again." }, { status: 502 })
    }
    const data = await res.json() as { success: boolean; data?: { url: string; display_url: string }; error?: { message?: string } }
    if (!data.success || !(data.data?.display_url || data.data?.url)) {
      console.error("[upload] imgbb fail", data?.error?.message)
      return NextResponse.json({ error: "Upload didn't go through. Try again, or use a smaller image." }, { status: 502 })
    }
    return NextResponse.json({ url: data.data?.display_url || data.data?.url })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === "AbortError"
    console.error("[upload] imgbb error", aborted ? "timeout" : e)
    return NextResponse.json({
      error: aborted ? "Upload timed out. Check your connection and try again." : "Upload failed. Try again in a moment.",
    }, { status: 502 })
  }
}