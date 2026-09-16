import crypto from "crypto"

function key(): Buffer {
  const value = process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || ""
  if (value.length < 32 && process.env.NODE_ENV === "production") {
    throw new Error("UNSUBSCRIBE_SECRET or SESSION_SECRET must be at least 32 characters")
  }
  return crypto.createHash("sha256").update(`unsubscribe:${value || "arcat-dev-unsubscribe-only"}`).digest()
}

export function createUnsubscribeToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email: email.toLowerCase().trim() })).toString("base64url")
  const signature = crypto.createHmac("sha256", key()).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

export function readUnsubscribeToken(token: string | null): string | null {
  if (!token) return null
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null
  const expected = crypto.createHmac("sha256", key()).update(payload).digest("base64url")
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const email = String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.email || "").toLowerCase().trim()
    return /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(email) ? email : null
  } catch {
    return null
  }
}
