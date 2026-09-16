import crypto from "crypto"

export function hasAdminAuthorization(req: Request): boolean {
  const expected = process.env.ADMIN_PASSWORD || ""
  const header = req.headers.get("authorization") || ""
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
