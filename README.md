<div align="center">
<img src="assets/arcat.png" alt="Arcat" width="150" />
</div>

# Arcat

Agent for [Arc](https://arc.network), Circle's stablecoin L1.

This repo is the tool layer: the HTTP API and on-chain indexer the agent reads from.
The agent itself is not here, see [Scope](#scope).

**Status:** in development, not deployed.

## What it does

Arcat answers questions about Arc from live chain data, and settles USDC to the
builders whose work it cites.

First milestone is a token deploy. Give it a wallet, tell it to put an ERC-20 on Arc,
and have it compile, fund, sign and broadcast with no human touching the key. That
either shows up on chain or it doesn't. Address goes in [Links](#links) when it does.

## Scope

In this repo:

* `src/app/api` : 62 routes over Arc ecosystem data. `/api/manifest` returns a
  machine-readable index of them, so an agent can discover the surface at runtime
  instead of being handed docs.
* `indexer.js`, `src/app/api/cron` : block ingestion and metric refresh.
* `src/lib` : chain access, Postgres, trust engine, TVL.
* `contracts/ArcatRegistry.sol` : on-chain trust attestations.

Not in this repo: the planning loop, the prompts, the signing path. Those stay private.
The tool layer is the half where correctness is checkable by reading it, so that's the
half that's public.

## Running locally

```bash
npm install
npm run dev
curl localhost:3000/api/manifest
```

No UI, everything is over the API. `DATABASE_URL` and `ARC_RPC_HTTP` are the minimum to
boot. The rest gate individual features.

## Indexer notes

Log scanning uses `eth_getLogs` with range bisection, because providers cap the block
range and the cap varies between them. On a rate limit it backs off and retries behind
a concurrency gate. It keeps a six block confirmation buffer so reorgs don't write bad
rows. For DEXes with more pools than are practical to scan directly it falls back to a
subgraph.

Metrics carry their measurement method. On-chain verified figures and protocol reported
figures are stored separately and never merged, since merging them loses the provenance
and you can no longer tell which numbers were checked.

Trust standing is a badge ladder (Listed, Claimed, Verified, plus Established and
partner tiers) derived from on-chain attestations and verification signals, written
through `ArcatRegistry`.

## Configuration

Read from the environment only, nothing is committed.

| Variable | Group | Purpose |
|---|---|---|
| `DATABASE_URL` | Core | PostgreSQL connection string |
| `ARC_RPC_HTTP` | Core | Arc RPC endpoint for the indexer |
| `SESSION_SECRET` | Core | Signs session cookies |
| `ADMIN_PASSWORD` | Core | Administrative endpoints |
| `NEXT_PUBLIC_BASE_URL` | Core | Canonical service URL |
| `ARC_CHAIN_ID`, `ARC_EXPLORER_API` | Arc | Chain id and explorer API base |
| `NEXT_PUBLIC_ARC_RPC_HTTP` | Arc | RPC endpoint used by seeding scripts |
| `ARCAT_REGISTRY` | Arc | Trust registry contract address |
| `ATTESTER_PRIVATE_KEY`, `ATTESTER_ADDRESS` | Trust | Signs on-chain attestations |
| `VIRUSTOTAL_API_KEY` | Trust | URL reputation scanning |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle | Developer-Controlled Wallets |
| `NEXT_PUBLIC_CIRCLE_APP_ID` | Circle | User-Controlled Wallets |
| `PAYOUT_WALLET_PRIVATE_KEY`, `PAYOUT_WALLET_ADDRESS` | Trials | Settles campaign payouts in USDC |
| `RESEND_API_KEY`, `MAIL_FROM`, `TEAM_EMAIL` | Email | Transactional mail |
| `OTP_PEPPER`, `UNSUBSCRIBE_SECRET` | Email | Hardens OTPs and unsubscribe links |
| `BLOB_READ_WRITE_TOKEN`, `IMGBB_API_KEY` | Uploads | Asset hosting |
| `CRON_SECRET` | Ops | Authorizes scheduled jobs |
| `DEPLOYER_PRIVATE_KEY` | Scripts | Deploys the registry contract |

## Scheduled jobs

Defined in `vercel.json`, all behind `CRON_SECRET`.

| Job | Schedule | Purpose |
|---|---|---|
| `tvl-revenue` | */15 * * * * | Refresh TVL and revenue |
| `tvl-drift` | 0 * * * * | Detect drift between reported and measured figures |
| `subgraph-metrics` | 0 4 * * * | Reconcile against subgraph sources |
| `trust-recheck` | 30 3 * * * | Re-evaluate trust standing |
| `rescan-urls` | 20 */6 * * * | Re-scan project URLs for reputation changes |
| `forex-refresh` | 0 6 * * * | Refresh FX reference rates |

## Links

| | |
|---|---|
| Token | https://argus.world/token/0x91b757B0e48c22c61f1CD45f21edd8b098c52e88 |

## License

MIT, see [LICENSE](LICENSE).
