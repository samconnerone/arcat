// src/lib/arc.ts
// Arc RPC provider — singleton pattern so we never open duplicate connections.
// Uses ethers v6. All monetary values returned in USDC (6 decimals).

import { ethers } from "ethers"
import {
  ARC_RPC_HTTP,
  ARC_RPC_WS,
  ARC_CHAIN_ID,
  USDC_ADDRESS,
  formatUSDC,
} from "./constants"

// ─── SINGLETON HTTP PROVIDER ─────────────────────────────────────────────────
let _httpProvider: ethers.JsonRpcProvider | null = null

export function getProvider(): ethers.JsonRpcProvider {
  if (!_httpProvider) {
    _httpProvider = new ethers.JsonRpcProvider(ARC_RPC_HTTP, {
      chainId: ARC_CHAIN_ID,
      name:    "arc-testnet",
    })
  }
  return _httpProvider
}

// ─── SINGLETON WEBSOCKET PROVIDER ────────────────────────────────────────────
let _wsProvider: ethers.WebSocketProvider | null = null

export function getWsProvider(): ethers.WebSocketProvider {
  if (!_wsProvider) {
    _wsProvider = new ethers.WebSocketProvider(ARC_RPC_WS, {
      chainId: ARC_CHAIN_ID,
      name:    "arc-testnet",
    })

    ;(_wsProvider.websocket as WebSocket).addEventListener("close", () => {
      console.warn("[Arcat] WebSocket closed — reconnecting…")
      _wsProvider = null
      setTimeout(getWsProvider, 3000)
    })
  }
  return _wsProvider
}

// ─── USDC CONTRACT ────────────────────────────────────────────────────────────
const USDC_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]

export function getUSDCContract(
  signerOrProvider?: ethers.Signer | ethers.Provider
): ethers.Contract {
  return new ethers.Contract(
    USDC_ADDRESS,
    USDC_ABI,
    signerOrProvider ?? getProvider()
  )
}

// ─── TYPED FETCH FUNCTIONS ────────────────────────────────────────────────────

export async function getLatestBlock() {
  const provider = getProvider()
  const block = await provider.getBlock("latest", true)
  if (!block) throw new Error("Could not fetch latest block")

  const baseFeeGwei = block.baseFeePerGas
    ? Number(ethers.formatUnits(block.baseFeePerGas, "gwei"))
    : 160

  // Use BigInt() instead of bigint literals (160n, 9n, 12n)
  const baseFee = block.baseFeePerGas ?? BigInt(160) * BigInt(10) ** BigInt(9)
  const feeRaw  = block.gasUsed * baseFee / BigInt(10) ** BigInt(12)

  return {
    number:       block.number,
    hash:         block.hash,
    timestamp:    block.timestamp,
    txCount:      block.transactions.length,
    gasUsed:      block.gasUsed,
    gasLimit:     block.gasLimit,
    baseFeeGwei,
    feeUSDC:      formatUSDC(feeRaw),
    validator:    block.miner,
    parentHash:   block.parentHash,
  }
}

export async function getTransaction(hash: string) {
  const provider = getProvider()
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
  ])

  if (!tx) throw new Error(`Transaction not found: ${hash}`)

  // ethers v6: the effective gas price lives on receipt.gasPrice
  const baseFee  = receipt?.gasPrice ?? tx.gasPrice ?? BigInt(160) * BigInt(10) ** BigInt(9)
  const gasUsed  = receipt?.gasUsed ?? BigInt(0)
  const feeWei   = gasUsed * baseFee
  const feeUSDC  = formatUSDC(feeWei / BigInt(10) ** BigInt(12))
  const valueUSDC = formatUSDC(tx.value / BigInt(10) ** BigInt(12))

  return {
    hash:          tx.hash,
    blockNumber:   tx.blockNumber,
    from:          tx.from,
    to:            tx.to,
    value:         tx.value,
    valueUSDC,
    gasUsed:       receipt?.gasUsed ?? BigInt(0),
    gasPrice:      baseFee,
    feeUSDC,
    status:        receipt?.status === 1 ? "confirmed" : receipt ? "failed" : "pending",
    data:          tx.data,
    nonce:         tx.nonce,
    logs:          receipt?.logs ?? [],
    confirmations: receipt ? (await provider.getBlockNumber()) - (tx.blockNumber ?? 0) : 0,
  }
}

export async function getAddressInfo(address: string) {
  const provider = getProvider()
  const usdc     = getUSDCContract()

  const [txCount, usdcBalance, code] = await Promise.all([
    provider.getTransactionCount(address),
    usdc.balanceOf(address).catch(() => BigInt(0)),
    provider.getCode(address),
  ])

  const isContract = code !== "0x"

  return {
    address,
    txCount,
    usdcBalance:    formatUSDC(usdcBalance),
    usdcBalanceRaw: usdcBalance,
    isContract,
    code:           isContract ? code : null,
  }
}

export async function getGasInfo() {
  const provider    = getProvider()
  const feeData     = await provider.getFeeData()
  const baseFeeGwei = feeData.gasPrice
    ? Number(ethers.formatUnits(feeData.gasPrice, "gwei"))
    : 160

  return {
    baseFeeGwei: Math.round(baseFeeGwei),
    costs: {
      transfer:       `$${(baseFeeGwei * 21000  * 1e-9).toFixed(4)}`,
      erc20Transfer:  `$${(baseFeeGwei * 46000  * 1e-9).toFixed(4)}`,
      contractCall:   `$${(baseFeeGwei * 85000  * 1e-9).toFixed(4)}`,
      contractDeploy: `$${(baseFeeGwei * 200000 * 1e-9).toFixed(4)}`,
    },
  }
}

export async function getRecentBlocks(count = 10) {
  const provider  = getProvider()
  const latest    = await provider.getBlockNumber()
  const blockNums = Array.from({ length: count }, (_, i) => latest - i)

  const blocks = await Promise.all(
    blockNums.map(n => provider.getBlock(n, false))
  )

  return blocks.filter(Boolean).map(b => {
    const baseFee = b!.baseFeePerGas ?? BigInt(160) * BigInt(10) ** BigInt(9)
    const feeRaw  = b!.gasUsed * baseFee / BigInt(10) ** BigInt(12)
    return {
      number:    b!.number,
      hash:      b!.hash,
      timestamp: b!.timestamp,
      txCount:   b!.transactions.length,
      gasUsed:   b!.gasUsed,
      validator: b!.miner,
      feeUSDC:   formatUSDC(feeRaw),
    }
  })
}

export async function getUSDCSupply(): Promise<string> {
  const usdc   = getUSDCContract()
  const supply = await usdc.totalSupply()
  return formatUSDC(supply)
}

export function decodeTransferLogs(
  logs: ethers.Log[]
): { from: string; to: string; amount: string }[] {
  const transferTopic = ethers.id("Transfer(address,address,uint256)")
  return logs
    .filter(log => log.topics[0] === transferTopic)
    .map(log => {
      const from   = `0x${log.topics[1].slice(26)}`
      const to     = `0x${log.topics[2].slice(26)}`
      const amount = BigInt(log.data)
      return { from, to, amount: formatUSDC(amount) }
    })
}