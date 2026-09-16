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

// Accepts a generic contract execution request.
// Caller supplies contractAddress, abiFunctionSignature, abiParameters.
export async function POST(req: NextRequest) {
  const blocked = await enforce(req, "circle-sign-tx", { limit: 20, windowMs: 60_000 })
  if (blocked) return blocked
  try {
    const { email, contractAddress, abiFunctionSignature, abiParameters } = await req.json()
    if (!email || !contractAddress || !abiFunctionSignature)
      return NextResponse.json({ error: "email, contractAddress, abiFunctionSignature required" }, { status: 400 })
    const lower = String(email).toLowerCase().trim()
    if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress))) {
      return NextResponse.json({ error: "Invalid contract address" }, { status: 400 })
    }
    const allowedFunctions = new Set(["transfer(address,uint256)", "approve(address,uint256)"])
    if (!allowedFunctions.has(String(abiFunctionSignature))) {
      return NextResponse.json({ error: "Unsupported transaction type" }, { status: 400 })
    }
    if (!Array.isArray(abiParameters) || abiParameters.length !== 2 || abiParameters.some(v => typeof v !== "string" || v.length > 100)) {
      return NextResponse.json({ error: "Invalid transaction parameters" }, { status: 400 })
    }
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
    const { userToken, encryptionKey } = tokenData.data

    const txRes  = await fetch(`${BASE}/v1/w3s/user/transactions/contractExecution`, {
      method:  "POST",
      headers: apiHeaders(userToken),
      body:    JSON.stringify({
        idempotencyKey:       crypto.randomUUID(),
        walletId:             wallet_id,
        contractAddress,
        abiFunctionSignature,
        abiParameters:        abiParameters ?? [],
        feeLevel:             "MEDIUM",
      }),
    })
    const txData = await txRes.json()
    if (!txRes.ok) {
      console.error("[circle/sign/transaction]", txData)
      return NextResponse.json({ error: "Failed to create transaction challenge", detail: txData }, { status: 500 })
    }

    return NextResponse.json({ userToken, encryptionKey, challengeId: txData.data.challengeId })
  } catch (e) {
    console.error("[circle/sign/transaction]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
