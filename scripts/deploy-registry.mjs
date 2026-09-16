// scripts/deploy-registry.mjs
// Compiles contracts/ArcatRegistry.sol and deploys it to Arc.
//
// Standalone, manual-run tool. It does NOT touch the app, the database, or
// production — it only deploys a contract from the key you provide.
//
// One-time prep:
//   npm i -D solc
//
// Run:
//   DEPLOYER_PRIVATE_KEY=0x...        # a DEDICATED attester wallet (NOT your payout DCW),
//                                     # funded with a little USDC on Arc for gas
//   [ATTESTER_ADDRESS=0x...]          # optional: also authorize a second writer
//   [ARC_RPC_HTTP=https://rpc.testnet.arc.network]
//   [ARC_CHAIN_ID=5042002]
//   node scripts/deploy-registry.mjs
//
// After it prints the address, set in your env:  NEXT_PUBLIC_ARCAT_REGISTRY=0x...

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"
import { createWalletClient, createPublicClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"

dotenv.config({ path: ".env.local" })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RPC      = process.env.ARC_RPC_HTTP || "https://rpc.testnet.arc.network"
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002)
const PK       = process.env.DEPLOYER_PRIVATE_KEY
const EXTRA    = process.env.ATTESTER_ADDRESS // optional second authorized writer

if (!PK) {
  console.error("✗ Set DEPLOYER_PRIVATE_KEY — a dedicated wallet (not your payout DCW), funded with a little USDC on Arc for gas.")
  process.exit(1)
}

// 1) Compile with solc
let solc
try { solc = (await import("solc")).default } catch {
  console.error("✗ solc not installed. Run:  npm i -D solc")
  process.exit(1)
}
const srcPath = path.join(__dirname, "..", "contracts", "ArcatRegistry.sol")
const source  = fs.readFileSync(srcPath, "utf8")
const input = {
  language: "Solidity",
  sources: { "ArcatRegistry.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input)))
const fatals = (compiled.errors || []).filter(e => e.severity === "error")
;(compiled.errors || []).forEach(e => console.log(e.formattedMessage))
if (fatals.length) { console.error("✗ compile failed"); process.exit(1) }

const artifact = compiled.contracts["ArcatRegistry.sol"]["ArcatRegistry"]
const abi      = artifact.abi
const bytecode = ("0x" + artifact.evm.bytecode.object)

// 2) Deploy
const chain = {
  id: CHAIN_ID,
  name: "arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, // cosmetic; gas math is wei-based
  rpcUrls: { default: { http: [RPC] } },
}
const account = privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK)
const wallet  = createWalletClient({ account, chain, transport: http(RPC) })
const pub     = createPublicClient({ chain, transport: http(RPC) })

console.log(`Deploying ArcatRegistry`)
console.log(`  from   ${account.address}`)
console.log(`  chain  ${CHAIN_ID}  rpc ${RPC}`)
const hash = await wallet.deployContract({ abi, bytecode })
console.log(`  tx     ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash })
const address = receipt.contractAddress
console.log(`\n✅ ArcatRegistry deployed at: ${address}`)
console.log(`   owner + attester: ${account.address}`)

// 3) Optionally authorize a second writer
if (EXTRA) {
  console.log(`\nAuthorizing extra attester ${EXTRA} ...`)
  const h2 = await wallet.writeContract({ address, abi, functionName: "setAttester", args: [EXTRA, true] })
  await pub.waitForTransactionReceipt({ hash: h2 })
  console.log(`✅ authorized ${EXTRA}`)
}

// 4) Save the ABI for the app to read later
const abiOut = path.join(__dirname, "..", "contracts", "ArcatRegistry.abi.json")
fs.writeFileSync(abiOut, JSON.stringify(abi, null, 2))
console.log(`\nSaved ABI -> ${abiOut}`)
console.log(`\nNext steps:`)
console.log(`  • set NEXT_PUBLIC_ARCAT_REGISTRY=${address}`)
console.log(`  • keep the deployer key as your attester (e.g. ATTESTER_PRIVATE_KEY) — server-side only`)
console.log(`  • verify on the Arc explorer when ready`)
