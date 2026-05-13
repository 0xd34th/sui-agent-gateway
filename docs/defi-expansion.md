# Sui DeFi Expansion Map

Generated from DeFiLlama's public protocols API on 2026-05-12. Rankings move with TVL, so use the `list_sui_defi_protocols` MCP tool for live data.

## Product Rule

Do not integrate every top-30 protocol as a flat list of tools. Integrate activities with shared policy and then plug protocols into those activities.

## Activity Tiers

1. Swaps
   - Current: 7K, Aftermath, Cetus.
   - RWA issuer mint/redeem is out of scope because it may require KYC.
   - XAUM and XAGM are curated tokenized-metal swap assets. They route through the same quote/execute swap flow as any other coin.

2. Native and liquid staking
   - Current: native stake/unstake with preflight and minimum bounds.
   - Next: SpringSui, Haedal, Volo, AlphaFi stSUI adapters.

3. LP and vaults
   - Add pool discovery, deposit quote, withdraw quote, fee/APR display, impermanent-loss warning, and share-token tracking.
   - Start with Cetus, Bluefin Spot, DeepBook/Momentum/Magma/Turbos only where SDKs or safe PTB builders exist.

4. Lending and CDPs
   - Current: Scallop and Suilend supply/withdraw market discovery and transaction hooks.
   - Current: Bucket collateral discovery, positions, and collateral-only deposit hooks.
   - NAVI is tracked, but not real-executable until its SDK/PTB path is clean on the gateway's Sui v2 stack.
   - Add other supply/withdraw adapters before real borrow.
   - Borrow/mint flows should use real SDK/PTB paths only.
   - Required policy: collateral allowlist, max LTV, liquidation buffer, oracle freshness, per-protocol caps.

5. Derivatives
   - High-risk tier.
   - Required policy: leverage cap, reduce-only default, no market orders above cap, explicit confirmation.

6. CEX entries
   - Read-only only. They are not Sui DeFi smart-contract adapters.

## Why This Shape

The agent experience should be "I want gold", "stake SUI", "supply USDC", or "withdraw from this vault", not "which protocol API do I call?" Protocols should be replaceable route providers behind one activity surface.

## Added Tooling

- `list_defi_activities`: Activity-level support and policy state.
- `get_defi_action_plan`: Protocol/category/action to current support and next adapter work.
- `list_sui_defi_protocols`: Live DeFiLlama-ranked Sui protocols.
- `list_protocol_integrations`: Direct adapter status for the tracked top Sui DeFi protocols, including v2 compatibility notes and executable tools.
- `list_liquidity_protocols`: DEX, vault, and trading protocols tracked by the gateway.
- `list_tradable_assets`, `resolve_tradable_asset`: Curated asset resolution for Matrixdock Gold XAUM and Matrixdock Silver XAGM.
- `list_lending_providers`, `list_lending_markets`, `quote_lending_supply`, `lending_supply`, `quote_lending_withdraw`, `lending_withdraw`, `quote_lending_borrow`, `lending_borrow`, `get_lending_positions`.
- `list_cdp_providers`, `list_bucket_collateral_types`, `get_bucket_positions`, `quote_bucket_deposit_collateral`, `bucket_deposit_collateral`, `quote_bucket_borrow_usdb`, `bucket_borrow_usdb`.

## Requested Protocol Batch

- NAVI: tracked as lending, adapter-needed. The latest tested npm SDK pulls legacy Sui client helpers at runtime in this v2.16 stack.
- Suilend: implemented for supply/withdraw. The SDK is peer-pinned to `@mysten/sui@2.15.0`, but live market initialization works on the gateway's v2.16 stack; keep smoke tests in place when upgrading.
- Scallop: implemented for supply/withdraw. The SDK depends on `@mysten/sui@^2.11.0`.
- SpringSui: tracked as liquid staking, adapter-needed. The SDK is Sui v2-pinned, but direct Node ESM import smoke currently fails on generated module resolution, so do not expose execution until isolated.
- Ember: tracked as the strongest v2-compatible vault candidate. The SDK peers against `@mysten/sui@^2.0.0`, but vault deposit/withdraw still needs share-price, metadata, and dry-run integration.
- Bucket: partially implemented. Collateral discovery, positions, quote, collateral-only deposits, and USDB borrow/mint are wired through `@bucket-protocol/sdk`.
- Bucket Farm: tracked, adapter-needed. The core Bucket SDK is v2-compatible, but farm deposit/withdraw/harvest needs pool-specific PTB review.
- KAIO and Matrixdock metals: RWA issuer lifecycle is out of scope because mint/redeem may require KYC. XAUM/XAGM secondary-market swaps are supported through normal swap tools.
- Cetus, Bluefin Spot, DeepBook V3, Momentum, Magma, and Turbos: use aggregator swap routes first. Direct CLMM/LP support needs safe pool-specific adapters.
- Abyss: high-risk spot/margin/vault infrastructure. Track it, but require explicit risk policy and adapter review before execution.

## Current Top-30 Rule

For every live top-30 Sui protocol, the gateway should do one of four things:

- `implemented`: expose the execution tool and dry-run path.
- `partially_implemented`: expose the real safe subset only.
- `adapter_needed`: keep it visible with SDK/v2 notes, but do not pretend execution is ready.
- `out_of_scope`: show why the protocol is not an onchain gateway target, such as CEX custody or KYC issuer mint/redeem.

The practical v2 filter is: if the SDK is already smoke-tested with `@mysten/sui` v2, wire the safest action first; if it is v2-compatible by peer metadata but not smoke-tested, track it as the next adapter; if it pulls legacy Sui helpers, route through aggregators or keep it adapter-needed.
