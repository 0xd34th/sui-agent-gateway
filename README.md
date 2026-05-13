# Sui Agent Gateway

TypeScript MCP server for a capped Sui agent sub-wallet. It exposes agent-friendly tools for:

- Wallet creation, receive info, balances, and portfolio summary
- SuiNS resolution and capped token sends
- Swap quote comparison across 7K, Aftermath, and Cetus provider adapters
- Secondary-market Matrixdock gold/silver swaps via XAUM/XAGM coin resolution
- Native SUI staking and liquid-staking quote/execution hooks
- Scallop and Suilend supply/withdraw market discovery and guarded transaction hooks
- Bucket collateral discovery and guarded collateral-deposit hooks
- Explicit adapter status for the tracked top Sui DeFi protocols, including v2 compatibility notes
- Live Sui DeFi protocol discovery from DeFiLlama
- Local policy controls for spend caps, slippage, provider allowlists, and emergency pause

## Install

```bash
npm install
npm run build
```

## Run as an MCP server

```bash
npm start
```

The server stores its encrypted local wallet and policy under `.sui-agent-gateway/` by default. Set `SUI_AGENT_HOME` to override that path.

## 60-second setup

```bash
npm install
npm run build
```

Create `.env`:

```bash
SUI_NETWORK=mainnet
SUI_AGENT_HOME=.sui-agent-gateway
SUI_AGENT_KEYSTORE_SECRET=<make-this-long-and-random>
SUI_AGENT_ENABLE_MAINNET_WRITES=false
```

Create the agent wallet:

```bash
node -e "const c=await import('./dist/config.js'); const {Keystore}=await import('./dist/keystore.js'); const k=new Keystore(c.loadConfig()); console.log(k.create(false));"
```

Fund only the capped sub-wallet amount you are comfortable letting the agent use. The server auto-loads `.env` from the project root.

Run the MCP server:

```bash
npm start
```

Mainnet writes stay disabled until you set:

```bash
$env:SUI_AGENT_ENABLE_MAINNET_WRITES="true"
```

## Agent prompts that should work

```text
Create my Sui agent wallet and show the receive address.
Show my Sui balances.
Quote 1 SUI to USDC across all swap providers and show the best rate.
Quote 0.01 SUI to MANIFEST across 7K, Aftermath, and Cetus.
Swap 0.01 SUI to MANIFEST using the best dry-run route first.
Resolve gold to its Sui coin type, then quote 0.01 SUI to gold across all providers.
Resolve silver to its Sui coin type, then quote 0.01 SUI to silver across all providers.
List the top 30 Sui DeFi protocols and tell me which activities are supported.
Show me all DeFi activities this gateway supports or plans.
Send 0.1 SUI to name.sui as a dry run.
List native Sui validators.
Stake 1 SUI natively as a dry run.
List Scallop lending markets.
List Suilend lending markets.
Quote supplying 0.1 SUI to Scallop as a dry run.
Quote supplying 0.1 SUI to Suilend as a dry run.
Quote borrowing 0.01 SUI from Suilend.
Show adapter status for the top 30 Sui DeFi protocols.
Show adapter status for NAVI, Suilend, SpringSui, Ember, Bucket, KAIO, Turbos, and Abyss.
List Bucket collateral types.
Quote a Bucket collateral-only deposit without minting USDB.
Quote Bucket borrowing 1 USDB, depositing collateral in the same transaction if needed.
```

## The Easy Flow

1. `create_agent_wallet`
2. Fund the returned receive address.
3. `quote_all_swaps` with `coinInType`, `coinOutType`, and `amountIn`.
4. `execute_swap` with `dryRun: true`.
5. `execute_swap` again without `dryRun` after the user approves.
6. `quote_native_stake` or `native_stake_sui` with only `amountSui`; the gateway picks an active validator unless one is supplied.

`quote_all_swaps` ranks all available providers by net output. `execute_swap` defaults to the best valid quote, but accepts `provider` or `quoteId` when the user wants a specific route.

Native staking quotes include preflight and bounds. For example, trying `0.002 SUI` on mainnet returns a direct `below native stake minimum` response instead of requiring web searches.

## Built-in provider adapters

The server has SDK adapters enabled by default:

- `7k`: via `@bluefin-exchange/bluefin7k-aggregator-sdk`, which supports `@mysten/sui@2`
- `aftermath`: via `aftermath-ts-sdk`
- `cetus`: via `@cetusprotocol/aggregator-sdk`

The project intentionally does not install `@7kprotocol/sdk-ts` because its latest npm release peers against `@mysten/sui@^1.44.0`. For 7K on this v2 stack, the Bluefin/7K aggregator SDK is the compatible path.

Optional custom HTTP adapters still work with:

- `SEVENK_QUOTE_URL`, optional `SEVENK_API_KEY`
- `AFTERMATH_QUOTE_URL`, optional `AFTERMATH_API_KEY`
- `CETUS_QUOTE_URL`, optional `CETUS_API_KEY`

The old `SEVENK_API_URL`, `AFTERMATH_API_URL`, and `CETUS_API_URL` names still work as fallbacks.

Each quote endpoint should accept:

```json
{
  "provider": "7k",
  "network": "mainnet",
  "coinInType": "0x2::sui::SUI",
  "coinOutType": "0x...",
  "amountIn": "1000000000",
  "slippageBps": 100,
  "sender": "0x..."
}
```

And return at least:

```json
{
  "expectedAmountOut": "123",
  "estimatedGasMist": "1000000",
  "routeSummary": "7K best route",
  "transactionBytes": "base64-transaction-bytes-for-execution"
}
```

Without `transactionBytes`, a custom HTTP adapter can rank quotes but will refuse to execute that quote.

## DeFi Expansion

Use `list_sui_defi_protocols` for a live DeFiLlama-backed map of the top Sui protocols, their categories, likely agent activities, and current adapter status.

Use `list_defi_activities` for the activity-first product surface and `get_defi_action_plan` to map a protocol/category/action into current support, required policy, and next adapter work.

Use `list_protocol_integrations` when you want direct status for a named batch or the whole tracked registry. This is the friend-safe truth table: it says which tools execute, which SDKs are Sui v2-compatible, and which still need a safe adapter.

Use `list_tradable_assets` or `resolve_tradable_asset` when a user says "gold", "silver", "XAUM", or "XAGM". The gateway resolves those names to curated Sui coin types and then uses normal `quote_all_swaps` / `execute_swap`.

Lending tools:

- `list_lending_providers`
- `list_lending_markets`
- `quote_lending_supply`
- `lending_supply`
- `quote_lending_withdraw`
- `lending_withdraw`
- `quote_lending_borrow`
- `lending_borrow`
- `get_lending_positions`

Current lending status:

- `scallop`: implemented for supply/withdraw with SDK-backed market discovery and dry-run support.
- `suilend`: implemented for supply/withdraw with SDK-backed market discovery and dry-run support.
- Borrow is real for Scallop and Suilend when the wallet already has an obligation/collateral account. NAVI, AlphaLend, and Current still need v2-safe adapters.
- `navi`: tracked, but adapter-needed for real transactions. The current npm SDK imports legacy Sui client helpers at runtime in this `@mysten/sui` v2 stack.
- `alphalend` and `current`: tracked, but adapter-needed.

CDP tools:

- `list_cdp_providers`
- `list_bucket_collateral_types`
- `get_bucket_positions`
- `quote_bucket_deposit_collateral`
- `bucket_deposit_collateral`
- `quote_bucket_borrow_usdb`
- `bucket_borrow_usdb`

Current CDP status:

- `bucket`: partially implemented for collateral discovery, positions, quote, collateral deposits, and real USDB borrow/mint manage-position dry-runs/transactions.
- `kai-finance`: tracked, but adapter-needed before any transaction support.

Liquidity and trading status:

- `cetus-clmm`, `bluefin-spot`, `deepbook-v3`, `momentum`, `magma`, and `turbos`: swaps are supported through 7K/Aftermath/Cetus routing when liquidity exists.
- `turbos`: swaps may already route through 7K/Aftermath/Cetus when liquidity exists. Direct Turbos CLMM/LP tooling still needs a v2-safe adapter.
- `abyss`: tracked as high-risk trading/vault infrastructure. It needs an audited adapter and risk policy before execution.
- `kaio`: no dedicated issuer/mint tooling. Use normal swaps only when there is a verified coin type and aggregator liquidity.

V2-compatible candidates not yet exposed as execution tools:

- `ember-protocol`: npm SDK peers against `@mysten/sui@^2.0.0`, but vault execution still needs metadata, share-price, withdrawal, and dry-run wiring.
- `bucket-farm`: Bucket SDK is v2-compatible, but farm deposit/withdraw/harvest needs pool-specific PTB review.
- `springsui`: SDK is pinned to Sui v2.15, but a direct Node ESM smoke hit generated-module resolution issues, so native SpringSui execution stays adapter-needed until isolated.

There are no XAUM/XAGM mint or redeem tools. Issuer mint/redeem can require KYC, so the gateway skips that path. XAUM and XAGM are curated as secondary-market tradable assets and use the normal `quote_all_swaps` / `execute_swap` tools like any other coin.

The expansion plan is in [docs/defi-expansion.md](docs/defi-expansion.md). The product rule is activity-first: add "stake", "supply", "withdraw", or "deposit vault" flows, then plug protocols into those flows behind policy and preflight.

## Useful environment variables

- `SUI_NETWORK`: `mainnet`, `testnet`, `devnet`, or `localnet` (default: `mainnet`)
- `SUI_GRPC_URL`: custom Sui gRPC fullnode URL
- `SUI_AGENT_HOME`: local storage directory
- `SUI_AGENT_KEYSTORE_SECRET`: secret used to encrypt the local sub-wallet
- `SUI_AGENT_ENABLE_MAINNET_WRITES`: set to `true` to allow signing on mainnet
- `SEVENK_QUOTE_URL`, `AFTERMATH_QUOTE_URL`, `CETUS_QUOTE_URL`: optional quote/build endpoints for HTTP quote adapters
- `SEVENK_API_KEY`, `AFTERMATH_API_KEY`, `CETUS_API_KEY`: optional provider API keys
- `HAEDAL_HASUI_COIN_TYPE`: optional verified haSUI coin type for secondary-market swap routing while native Haedal PTBs are not enabled

Mainnet writes are disabled by default as a safety rail. Testnet/devnet/localnet writes are allowed after policy checks. The server uses Sui's gRPC client from `@mysten/sui` rather than the legacy JSON-RPC client.
