import { NextRequest, NextResponse } from "next/server"
import { getPool } from "@/lib/dbPool"
import { enforce } from "@/lib/ratelimit"
import { readUnsubscribeToken } from "@/lib/unsubscribeToken"

const pool = getPool()

async function addUnsub(email: string) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_unsubscribes (
      email TEXT PRIMARY KEY,
      unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(
    `INSERT INTO email_unsubscribes (email) VALUES ($1) ON CONFLICT DO NOTHING`,
    [email],
  )
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "unsubscribe", { limit: 10, windowMs: 60_000 })
  if (blocked) return blocked
  try {
    const email = readUnsubscribeToken(req.nextUrl.searchParams.get("token"))
    if (!email) return new NextResponse("Invalid unsubscribe link", { status: 400 })
    await addUnsub(email)
    return new NextResponse("Unsubscribed", { status: 200 })
  } catch (err) {
    console.error("[Unsubscribe POST]", err)
    return new NextResponse("Error", { status: 500 })
  }
}

// Browser clicks only show a confirmation. GET never changes subscription state.
export async function GET(req: NextRequest) {
  let email = ""
  try {
    email = readUnsubscribeToken(req.nextUrl.searchParams.get("token")) || ""
  } catch (err) {
    console.error("[Unsubscribe GET]", err)
  }
  const safeEmail = escapeHtml(email)
  const safeToken = escapeHtml(req.nextUrl.searchParams.get("token") || "")
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribe — Arcat</title>
  <style>body{margin:0;font-family:Arial,sans-serif;background:#060c20;color:#e8ecff;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{text-align:center;max-width:400px;padding:40px 24px}.logo span:first-child{color:#e8ecff;font-size:24px;font-weight:700}.logo span:last-child{color:#1a56ff;font-size:24px;font-weight:700}h1{font-size:20px;margin:24px 0 8px}p{color:#6b7da8;font-size:14px;line-height:1.7}a{color:#1a56ff;text-decoration:none}button{border:0;border-radius:8px;background:#1a56ff;color:#fff;padding:12px 20px;font-weight:700;cursor:pointer}</style></head>
  <body><div class="box"><div class="logo"><span>Arc</span><span>Arcat</span></div>
    <h1>${safeEmail ? "Unsubscribe from Arcat?" : "Invalid unsubscribe link"}</h1>
    <p>${safeEmail ? `<strong style="color:#e8ecff">${safeEmail}</strong><br>Confirm below to stop marketing emails from Arcat.` : "This link is invalid or has been altered."}</p>
    ${safeEmail ? `<form method="post" action="/api/unsubscribe?token=${safeToken}"><button type="submit">Confirm unsubscribe</button></form>` : ""}
    <p style="margin-top:24px;font-size:12px;color:#2e3a5c">Transactional emails you request and security notices will still be delivered.</p>
  </div></body></html>`
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
}
