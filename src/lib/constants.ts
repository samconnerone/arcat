export const ARC_CHAIN_ID = 5042002
export const ARC_RPC_HTTP = "https://rpc.testnet.arc.network"
export const ARC_RPC_WS = "wss://ws.arc-testnet.io"
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000"
export const USDC_DECIMALS = 6
export const BASE_FEE_GWEI = BigInt(160)
export const BASE_FEE_WEI  = BigInt(160) * BigInt(10) ** BigInt(9)

export const ADD_CHAIN_PARAMS = {
  chainId: "0x4cef52",
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
} as const

export function gasToUSDC(gasUsed: number, baseFeeGwei = 160): string {
  const costUSDC = (gasUsed * baseFeeGwei * 1e-9)
  return "$" + costUSDC.toFixed(3)
}

export function formatUSDC(raw: bigint | string | number): string {
  const n = typeof raw === "bigint" ? raw : BigInt(String(raw))
  const million = BigInt(1000000)
  const whole = n / million
  const frac = n % million
  const fracStr = frac.toString().padStart(6, "0").slice(0, 2)
  return "$" + Number(whole).toLocaleString() + "." + fracStr
}

export function shortAddr(addr: string, chars = 4): string {
  if (!addr || addr.length < 10) return addr
  return addr.slice(0, chars + 2) + "..." + addr.slice(-chars)
}

export function shortHash(hash: string, chars = 6): string {
  if (!hash || hash.length < 14) return hash
  return hash.slice(0, chars + 2) + "..." + hash.slice(-chars)
}