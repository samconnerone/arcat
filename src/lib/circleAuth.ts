import type { NextRequest } from "next/server"
import { getPool } from "@/lib/dbPool"
import { getSession, readOtpProof } from "@/lib/session"

const pool = getPool()

export interface CircleWalletUser {
  circle_user_id: string
  wallet_id: string | null
  wallet_address: string | null
}

/** Authorize a Circle lookup with a server-signed session or recent OTP proof. */
export async function authorizeCircleUser(
  req: NextRequest,
  email: string,
  options: { allowOtpProof?: boolean; requireWallet?: boolean } = {},
): Promise<CircleWalletUser | null> {
  const lower = String(email || "").toLowerCase().trim()
  if (!lower) return null

  const session = getSession(req)
  const otpMatches = options.allowOtpProof === true && readOtpProof(req) === lower
  if (session?.type !== "circle" && !otpMatches) return null

  const result = await pool.query<CircleWalletUser>(
    `SELECT circle_user_id, wallet_id, wallet_address
       FROM circle_wallet_users
      WHERE email = $1
      LIMIT 1`,
    [lower],
  )
  const user = result.rows[0]
  if (!user) return null

  const sessionMatches = !!(
    session?.type === "circle" &&
    user.wallet_address &&
    session.addr === user.wallet_address.toLowerCase()
  )
  if (!sessionMatches && !otpMatches) return null
  if (options.requireWallet && (!user.wallet_id || !user.wallet_address)) return null
  return user
}
