import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { authorizeCircleUser } from "@/lib/circleAuth"
const BASE = "https://api.circle.com"

function apiHeaders(userToken?: string) {
  const h: Record<string, string> = {
    "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
    "Content-Type":  "application/json",
  }
  if (userToken) h["X-User-Token"] = userToken
  return h
}

// After a Circle contractExecution challenge completes, call this to get the on-chain txHash.
// Circle may take a few seconds to index the transaction, so we retry up to 6 times.
export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "circle-tx-latest", { limit: 30, windowMs: 60_000 })
  if (blocked) return blocked
  try {
    const { email } = await req.json()
    if (!email) return NextResponse.json({ error: "email required" }, { status: 400 })
    const lower = String(email).toLowerCase().trim()
    const user = await authorizeCircleUser(req, lower, { requireWallet: true })
    if (!user) return NextResponse.json({ error: "Sign in with this Circle wallet first" }, { status: 401 })

    const circle_user_id = user.circle_user_id
    const wallet_id = user.wallet_id!

    const tokenRes  = await fetch(`${BASE}/v1/w3s/users/token`, {
      method:  "POST",
      headers: apiHeaders(),
      body:    JSON.stringify({ userId: circle_user_id }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) return NextResponse.json({ error: "Token failed" }, { status: 500 })
    const { userToken } = tokenData.data

    // Retry up to 6 times — Circle may take a moment to index the tx
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000))

      const txsRes  = await fetch(
        `${BASE}/v1/w3s/transactions?walletIds=${encodeURIComponent(wallet_id)}&pageSize=1`,
        { headers: apiHeaders(userToken) }
      )
      const txsData = await txsRes.json()
      const tx      = txsData.data?.transactions?.[0]

      if (tx?.txHash) return NextResponse.json({ txHash: tx.txHash, state: tx.state })
      if (tx?.state === "FAILED") return NextResponse.json({ error: "Transaction failed on-chain" }, { status: 422 })
    }

    return NextResponse.json({ error: "Transaction not yet confirmed. Check again shortly." }, { status: 408 })
  } catch (e) {
    console.error("[circle/tx/latest]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
