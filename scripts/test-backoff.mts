// Runtime test for the rate-limit backoff in getLogsBisecting.
// Run: npx tsx scripts/test-backoff.mts
import { getLogsBisecting } from "../src/lib/tvl"

let pass = 0, fail = 0
function assert(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`) }
}

// The EXACT shape ethers surfaces the QuickNode error as (from the live alert log).
function rateLimitError() {
  const e: any = new Error("could not coalesce error")
  e.error = { code: -32007, message: "100/second request limit reached - reduce calls per second or upgrade your account at https://dashboard.quicknode.com/billing/plan" }
  return e
}
function oversizeError() {
  const e: any = new Error("eth_getLogs is limited to a 10,000 range")
  e.error = { code: -32614, message: "eth_getLogs is limited to a 10,000 range" }
  return e
}
const logAt = (b: number) => ({ blockNumber: b, transactionHash: "0x" + b.toString(16), index: 0, topics: [], data: "0x" })

// 1. Rate-limited twice, then succeeds → should retry same range and return the log.
{
  let calls = 0
  const mock: any = { getLogs: async (f: any) => { calls++; if (calls <= 2) throw rateLimitError(); return [logAt(f.fromBlock)] } }
  const t0 = Date.now()
  const res = await getLogsBisecting(mock, {}, 100, 200)
  const ms = Date.now() - t0
  assert("recovers after 2 rate-limits (3 calls total)", calls === 3, `got ${calls} calls`)
  assert("returns the log once recovered", res.length === 1)
  assert("range was NOT bisected (same from/to retried)", res[0]?.blockNumber === 100)
  assert("backed off before retrying (waited ~1.2s+)", ms >= 1100, `waited ${ms}ms`)
}

// 2. Rate-limited forever → should give up after retries and THROW (so cursor won't advance).
{
  let calls = 0
  const mock: any = { getLogs: async () => { calls++; throw rateLimitError() } }
  let threw = false
  try { await getLogsBisecting(mock, {}, 100, 200) } catch { threw = true }
  assert("throws when rate-limit never clears", threw)
  assert("tried initial + MAX_RL_RETRIES (5 attempts)", calls === 5, `got ${calls} attempts`)
}

// 3. Oversize error still bisects (regression guard).
{
  let calls = 0
  const mock: any = { getLogs: async (f: any) => { calls++; if (f.toBlock - f.fromBlock > 0) throw oversizeError(); return [logAt(f.fromBlock)] } }
  const res = await getLogsBisecting(mock, {}, 100, 101)
  assert("oversize bisects down to single blocks", res.length === 2, `got ${res.length} logs`)
}

// 4. A non-retryable error surfaces immediately (no silent swallow).
{
  let calls = 0
  const mock: any = { getLogs: async () => { calls++; throw new Error("some other network blip") } }
  let threw = false
  try { await getLogsBisecting(mock, {}, 100, 200) } catch { threw = true }
  assert("unrelated errors throw straight away", threw && calls === 1, `calls=${calls}`)
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
