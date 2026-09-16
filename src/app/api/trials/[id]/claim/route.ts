import { NextRequest, NextResponse } from "next/server"
import { enforce } from "@/lib/ratelimit"
import { getSession } from "@/lib/session"
import { getPool } from "@/lib/dbPool"

const pool = getPool()

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limit: only the legitimate tester needs this endpoint and they need it
  // exactly once per completion, so 5/min/IP is plenty and stops abuse.
  const blocked = await enforce(req, "trial-reward-claim", { limit: 5, windowMs: 60_000 })
  if (blocked) return blocked

  try {
    const { tester_wallet } = await req.json()
    const { id } = await params

    if (!tester_wallet?.trim()) return NextResponse.json({ error: "Wallet required" }, { status: 400 })
    const wallet = tester_wallet.toLowerCase()

    // Only the actual tester can claim their reward — must be signed in as them
    const sess = getSession(req)
    if (!sess || sess.addr !== wallet) {
      return NextResponse.json({ error: "Sign in with the tester wallet to claim this reward" }, { status: 401 })
    }

    // Resolve slug or numeric id
    const isNumeric = /^\d+$/.test(id)
    const campRes = await pool.query(
      `SELECT id, status, reward_type, reward_usdc_amount, deposit_tx_hash FROM campaigns WHERE ${isNumeric ? "id = $1" : "slug = $1"}`,
      [isNumeric ? Number(id) : id]
    )
    const campaignId: number = campRes.rows[0]?.id
    if (!campRes.rows.length)              return NextResponse.json({ error: "Campaign not found" }, { status: 404 })
    const campaign = campRes.rows[0]
    if (campaign.status !== "active")      return NextResponse.json({ error: "Campaign is not active" }, { status: 400 })
    if (campaign.reward_type !== "usdc")   return NextResponse.json({ error: "This campaign does not offer USDC rewards" }, { status: 400 })
    if (!campaign.reward_usdc_amount)      return NextResponse.json({ error: "USDC reward amount not set" }, { status: 400 })
    if (!campaign.deposit_tx_hash)         return NextResponse.json({ error: "Campaign has not been funded by the founder yet" }, { status: 400 })

    const circleApiKey     = process.env.CIRCLE_API_KEY
    const circleSecret     = process.env.CIRCLE_ENTITY_SECRET
    const payoutWalletAddr = process.env.PAYOUT_WALLET_ADDRESS
    const payoutPrivKey    = process.env.PAYOUT_WALLET_PRIVATE_KEY

    if (!circleApiKey && !payoutPrivKey) {
      return NextResponse.json({ error: "USDC payouts not yet configured — contact the campaign builder directly" }, { status: 503 })
    }

    // Atomically claim the completion: lock the row, validate it, flip
    // reward_delivered=true BEFORE sending USDC. If the send fails we
    // restore the flag. Two simultaneous requests can no longer
    // double-pay because the second one finds reward_delivered already
    // true once the first transaction commits.
    const client = await pool.connect()
    let completionId: number
    try {
      await client.query("BEGIN")
      const compRes = await client.query(
        `SELECT id, auto_score, reward_delivered
         FROM campaign_completions
         WHERE campaign_id = $1 AND tester_wallet = $2
         FOR UPDATE`,
        [campaignId, wallet]
      )
      if (!compRes.rows.length) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "No completion found for this wallet" }, { status: 404 })
      }
      const completion = compRes.rows[0]
      if (completion.reward_delivered) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Reward already claimed" }, { status: 400 })
      }
      if (completion.auto_score < 1) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Completion not scored yet" }, { status: 400 })
      }
      await client.query(
        `UPDATE campaign_completions SET reward_delivered = true WHERE id = $1`,
        [completion.id]
      )
      await client.query("COMMIT")
      completionId = completion.id
    } catch (e) {
      try { await client.query("ROLLBACK") } catch {}
      throw e
    } finally {
      client.release()
    }

    // Arc App Kit — server-side USDC send via Circle Developer-Controlled Wallet
    const { AppKit } = await import("@circle-fin/app-kit")
    const kit = new AppKit()

    let result: unknown
    try {
      if (circleApiKey && circleSecret && payoutWalletAddr) {
        const { createCircleWalletsAdapter } = await import("@circle-fin/adapter-circle-wallets")
        const adapter = createCircleWalletsAdapter({ apiKey: circleApiKey, entitySecret: circleSecret })
        result = await kit.send({
          from:  { adapter: adapter as any, chain: "Arc_Testnet", address: payoutWalletAddr as `0x${string}` },
          to:    wallet,
          amount: String(campaign.reward_usdc_amount),
          token: "USDC",
        })
      } else {
        const { createAdapterFromPrivateKey } = await import("@circle-fin/adapter-viem-v2")
        const adapter = await createAdapterFromPrivateKey({ privateKey: payoutPrivKey as `0x${string}` } as any)
        result = await kit.send({
          from:  { adapter: adapter as any, chain: "Arc_Testnet" },
          to:    wallet,
          amount: String(campaign.reward_usdc_amount),
          token: "USDC",
        })
      }
    } catch (payErr) {
      // Payout failed — restore the flag so the tester can retry
      try {
        await pool.query(`UPDATE campaign_completions SET reward_delivered = false WHERE id = $1`, [completionId])
      } catch (rollbackErr) {
        console.error("[Claim] CRITICAL: payout failed AND flag restore failed:", { payErr, rollbackErr, completionId })
      }
      throw payErr
    }

    const txHash = (result as any)?.txHash || (result as any)?.hash || ""
    return NextResponse.json({ success: true, tx_hash: txHash, amount: campaign.reward_usdc_amount })
  } catch (e) {
    console.error("[Claim]", e)
    return NextResponse.json({ error: "Server error" }, { status: 500 })
  }
}
