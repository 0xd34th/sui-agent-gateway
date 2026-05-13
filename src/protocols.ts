export type ProtocolIntegration = {
  slug: string;
  name: string;
  category:
    | "lending"
    | "liquid_staking"
    | "cdp"
    | "rwa"
    | "dex"
    | "farm"
    | "vault"
    | "derivatives"
    | "cex"
    | "leveraged_farming"
    | "yield"
    | "trading";
  status: "implemented" | "partially_implemented" | "read_only" | "adapter_needed" | "out_of_scope";
  tools: string[];
  sdk?: {
    packageName?: string;
    version?: string;
    suiCompatibility: "v2_compatible" | "v2_smoke_tested" | "v1_or_legacy" | "unknown" | "not_applicable" | "conflicting_peers";
    notes: string;
  };
  notes: string;
};

const SWAP_TOOLS = ["quote_all_swaps", "quote_swap", "execute_swap"];
const LENDING_TOOLS = ["list_lending_markets", "quote_lending_supply", "lending_supply", "quote_lending_withdraw", "lending_withdraw", "quote_lending_borrow", "lending_borrow", "get_lending_positions"];

const PROTOCOLS: ProtocolIntegration[] = [
  {
    slug: "navi-lending",
    name: "NAVI Lending",
    category: "lending",
    status: "adapter_needed",
    tools: ["list_lending_markets"],
    sdk: { packageName: "@naviprotocol/lending", version: "1.4.3", suiCompatibility: "v1_or_legacy", notes: "Peer says >=1.25.0, but runtime smoke hit legacy Sui helper issues in the v2.16 stack." },
    notes: "Tracked as a lending target. Do not expose execution until the SDK/PTB path is v2-safe.",
  },
  {
    slug: "navi",
    name: "NAVI",
    category: "lending",
    status: "adapter_needed",
    tools: ["list_lending_markets"],
    sdk: { packageName: "@naviprotocol/lending", version: "1.4.3", suiCompatibility: "v1_or_legacy", notes: "Peer says >=1.25.0, but runtime smoke hit legacy Sui helper issues in the v2.16 stack." },
    notes: "Alias for NAVI Lending.",
  },
  {
    slug: "suilend",
    name: "Suilend",
    category: "lending",
    status: "implemented",
    tools: LENDING_TOOLS,
    sdk: { packageName: "@suilend/sdk", version: "3.0.3", suiCompatibility: "v2_smoke_tested", notes: "Peer-pinned to @mysten/sui 2.15.0, but market discovery and SUI supply dry-run pass on the gateway v2.16 stack." },
    notes: "Supply/withdraw/borrow are SDK-backed. Borrow requires an existing obligation owner cap and collateral.",
  },
  {
    slug: "scallop",
    name: "Scallop",
    category: "lending",
    status: "implemented",
    tools: LENDING_TOOLS,
    sdk: { packageName: "@scallop-io/sui-scallop-sdk", version: "3.0.2", suiCompatibility: "v2_compatible", notes: "Depends on @mysten/sui ^2.11.0." },
    notes: "Supply/withdraw/borrow are SDK-backed. Borrow requires an existing obligation/key and collateral.",
  },
  {
    slug: "scallop-lend",
    name: "Scallop Lend",
    category: "lending",
    status: "implemented",
    tools: LENDING_TOOLS,
    sdk: { packageName: "@scallop-io/sui-scallop-sdk", version: "3.0.2", suiCompatibility: "v2_compatible", notes: "Depends on @mysten/sui ^2.11.0." },
    notes: "Alias for Scallop lending.",
  },
  {
    slug: "alphalend",
    name: "AlphaLend",
    category: "lending",
    status: "adapter_needed",
    tools: ["list_lending_providers"],
    sdk: { packageName: "@alphafi/alphalend-sdk", version: "2.0.1", suiCompatibility: "v1_or_legacy", notes: "Peer-pinned to @mysten/sui 1.45.0 and pulls NAVI/7K legacy packages." },
    notes: "Do not execute until a v2 adapter is isolated or upstream migrates.",
  },
  {
    slug: "current",
    name: "Current",
    category: "lending",
    status: "adapter_needed",
    tools: ["list_lending_providers"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript adapter found yet." },
    notes: "Needs protocol adapter discovery.",
  },
  {
    slug: "springsui",
    name: "SpringSui",
    category: "liquid_staking",
    status: "adapter_needed",
    tools: ["list_liquid_stake_providers", "quote_liquid_stake"],
    sdk: { packageName: "@suilend/springsui-sdk", version: "3.0.1", suiCompatibility: "conflicting_peers", notes: "Peer-pinned to @mysten/sui 2.15.0; direct Node ESM smoke hit generated-module resolution issues." },
    notes: "Native SpringSui stake/unstake needs adapter isolation before execution. Swaps to LST may route through aggregators when coin types are configured.",
  },
  {
    slug: "haedal-protocol",
    name: "Haedal Protocol",
    category: "liquid_staking",
    status: "partially_implemented",
    tools: ["quote_liquid_stake", "quote_all_swaps", "execute_swap"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript stake adapter found yet." },
    notes: "Direct Haedal stake/unstake needs a PTB adapter. Secondary-market haSUI routing can use swaps when HAEDAL_HASUI_COIN_TYPE is configured.",
  },
  {
    slug: "volo-lst",
    name: "Volo LST",
    category: "liquid_staking",
    status: "adapter_needed",
    tools: ["list_liquid_stake_providers", "quote_all_swaps", "execute_swap"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript stake adapter found yet." },
    notes: "Needs LST mint/unstake queue adapter; secondary-market swaps may work when routed by aggregators.",
  },
  {
    slug: "alphafi-stsui",
    name: "AlphaFi stSUI",
    category: "liquid_staking",
    status: "adapter_needed",
    tools: ["list_liquid_stake_providers", "quote_all_swaps", "execute_swap"],
    sdk: { packageName: "@alphafi/alphafi-sdk", version: "1.1.2", suiCompatibility: "v1_or_legacy", notes: "Peer-pinned to @mysten/sui 1.45.0." },
    notes: "Needs v2-safe adapter before native mint/unstake execution.",
  },
  {
    slug: "bucket-cdp",
    name: "Bucket CDP",
    category: "cdp",
    status: "partially_implemented",
    tools: ["list_cdp_providers", "list_bucket_collateral_types", "get_bucket_positions", "quote_bucket_deposit_collateral", "bucket_deposit_collateral", "quote_bucket_borrow_usdb", "bucket_borrow_usdb"],
    sdk: { packageName: "@bucket-protocol/sdk", version: "2.1.4", suiCompatibility: "v2_compatible", notes: "Peers @mysten/sui >=2.0.0." },
    notes: "Collateral discovery, positions, collateral deposit, and USDB borrow/mint are SDK-backed through Bucket manage-position transactions.",
  },
  {
    slug: "bucket-protocol-v2",
    name: "Bucket Protocol V2",
    category: "cdp",
    status: "partially_implemented",
    tools: ["list_cdp_providers", "list_bucket_collateral_types", "get_bucket_positions", "quote_bucket_deposit_collateral", "bucket_deposit_collateral", "quote_bucket_borrow_usdb", "bucket_borrow_usdb"],
    sdk: { packageName: "@bucket-protocol/sdk", version: "2.1.4", suiCompatibility: "v2_compatible", notes: "Peers @mysten/sui >=2.0.0." },
    notes: "Alias for Bucket CDP V2.",
  },
  {
    slug: "bucket",
    name: "Bucket Protocol",
    category: "cdp",
    status: "partially_implemented",
    tools: ["list_cdp_providers", "list_bucket_collateral_types", "get_bucket_positions", "quote_bucket_deposit_collateral", "bucket_deposit_collateral", "quote_bucket_borrow_usdb", "bucket_borrow_usdb"],
    sdk: { packageName: "@bucket-protocol/sdk", version: "2.1.4", suiCompatibility: "v2_compatible", notes: "Peers @mysten/sui >=2.0.0." },
    notes: "Alias for Bucket CDP.",
  },
  {
    slug: "bucket-farm",
    name: "Bucket Farm",
    category: "farm",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { packageName: "@bucket-protocol/sdk", version: "2.1.4", suiCompatibility: "v2_compatible", notes: "Core Bucket SDK is v2-compatible; farm deposit/harvest functions still need PTB review." },
    notes: "Needs farm-specific deposit/withdraw/harvest adapter with reward-token disclosure.",
  },
  {
    slug: "kai-finance",
    name: "Kai Finance",
    category: "leveraged_farming",
    status: "adapter_needed",
    tools: ["list_cdp_providers", "get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript adapter found yet." },
    notes: "Leveraged farming is high risk. Requires health-factor policy and explicit confirmation before execution.",
  },
  {
    slug: "ember-protocol",
    name: "Ember Protocol",
    category: "vault",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { packageName: "@ember-finance/sdk", version: "2.0.7", suiCompatibility: "v2_compatible", notes: "Peers @mysten/sui ^2.0.0 and @mysten/bcs ^2.0.3. Needs adapter isolation because current Suilend install pins @mysten/bcs 2.0.1." },
    notes: "Top priority v2-compatible vault adapter candidate. Needs vault metadata/share-price/dry-run integration.",
  },
  {
    slug: "cetus-clmm",
    name: "Cetus CLMM",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { packageName: "@cetusprotocol/aggregator-sdk", version: "1.5.3", suiCompatibility: "v2_compatible", notes: "Aggregator SDK is installed and live-smoked. Direct LP SDK peer is broad >=1.1.2 but LP PTBs are not wired." },
    notes: "Swaps route through Cetus aggregator. LP deposit/withdraw is not yet exposed.",
  },
  {
    slug: "bluefin-spot",
    name: "Bluefin Spot",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { packageName: "@bluefin-exchange/bluefin7k-aggregator-sdk", version: "6.0.0", suiCompatibility: "v2_compatible", notes: "Aggregator supports v2 gRPC primary client." },
    notes: "Spot exposure is supported through 7K/Cetus/Aftermath routing.",
  },
  {
    slug: "deepbook-v3",
    name: "DeepBook V3",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { suiCompatibility: "not_applicable", notes: "DeepBook liquidity is reachable through aggregators; direct order placement is not exposed." },
    notes: "Swap routing can use DeepBook through aggregators. Direct orderbook tools need separate risk controls.",
  },
  {
    slug: "momentum",
    name: "Momentum",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { suiCompatibility: "not_applicable", notes: "Routed by aggregators; no direct SDK needed for swaps." },
    notes: "Swap exposure is supported through aggregators. LP tools are not yet exposed.",
  },
  {
    slug: "magma",
    name: "Magma",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { packageName: "@magmaprotocol/magma-ts-sdk", version: "1.1.1", suiCompatibility: "unknown", notes: "Found package; peer compatibility not yet smoke-tested. Swaps already route through aggregators." },
    notes: "Swap exposure is supported through aggregators. Direct LP tools are not yet exposed.",
  },
  {
    slug: "abyss",
    name: "Abyss Protocol",
    category: "derivatives",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript execution adapter wired yet." },
    notes: "Track as high-risk trading/vault infrastructure. Requires adapter review, collateral policy, and explicit confirmation before execution.",
  },
  {
    slug: "turbos",
    name: "Turbos",
    category: "dex",
    status: "implemented",
    tools: SWAP_TOOLS,
    sdk: { packageName: "turbos-clmm-sdk", version: "3.6.4", suiCompatibility: "v1_or_legacy", notes: "Direct SDK peers @mysten/sui ^1.0.0, so direct LP is not enabled. Aggregator routes can still use Turbos pools." },
    notes: "Swap exposure is supported through aggregators. Direct CLMM/LP is adapter-needed.",
  },
  {
    slug: "kaio",
    name: "KAIO",
    category: "rwa",
    status: "implemented",
    tools: ["list_tradable_assets", "resolve_tradable_asset", ...SWAP_TOOLS],
    sdk: { suiCompatibility: "not_applicable", notes: "Issuer mint/redeem is intentionally skipped; secondary-market swaps use aggregator coin types." },
    notes: "RWA issuer lifecycle is out of scope when KYC is required. Verified secondary-market assets route through swaps.",
  },
  {
    slug: "matrixdock-xaum",
    name: "MatrixDock XAUM",
    category: "rwa",
    status: "implemented",
    tools: ["list_tradable_assets", "resolve_tradable_asset", ...SWAP_TOOLS],
    sdk: { suiCompatibility: "not_applicable", notes: "XAUM/XAGM are curated swap assets; issuer mint/redeem is not exposed." },
    notes: "XAUM and XAGM are supported as secondary-market swaps.",
  },
  {
    slug: "ondo-yield-assets",
    name: "Ondo Yield Assets",
    category: "rwa",
    status: "read_only",
    tools: ["get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified Sui v2 execution SDK wired yet." },
    notes: "Needs verified coin types and liquidity checks. Issuer flows may involve compliance requirements.",
  },
  {
    slug: "volo-vault",
    name: "Volo Vault",
    category: "vault",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript vault adapter found yet." },
    notes: "Needs vault metadata/share-price/withdrawal adapter.",
  },
  {
    slug: "alphafi-agg",
    name: "AlphaFi Agg",
    category: "vault",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { packageName: "@alphafi/alphafi-sdk", version: "1.1.2", suiCompatibility: "v1_or_legacy", notes: "Peer-pinned to @mysten/sui 1.45.0." },
    notes: "Needs v2-safe adapter before vault execution.",
  },
  {
    slug: "mole",
    name: "Mole",
    category: "yield",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript adapter found yet." },
    notes: "Needs vault/strategy adapter discovery.",
  },
  {
    slug: "sudo-perps",
    name: "Sudo Perps",
    category: "derivatives",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { suiCompatibility: "unknown", notes: "No verified public v2 TypeScript adapter wired yet." },
    notes: "High-risk. Needs leverage caps, collateral controls, and explicit confirmation.",
  },
  {
    slug: "bluefin-pro",
    name: "Bluefin Pro",
    category: "derivatives",
    status: "adapter_needed",
    tools: ["get_defi_action_plan"],
    sdk: { packageName: "@bluefin-exchange/pro-sdk", version: "2.0.0", suiCompatibility: "unknown", notes: "OpenAPI client exists; derivatives execution needs separate account/risk integration." },
    notes: "High-risk. Needs reduce-only defaults and leverage caps before execution.",
  },
  {
    slug: "bybit",
    name: "Bybit",
    category: "cex",
    status: "out_of_scope",
    tools: ["list_sui_defi_protocols"],
    sdk: { suiCompatibility: "not_applicable", notes: "Centralized exchange custody, not a Sui smart-contract adapter." },
    notes: "Read-only/out of scope for this onchain gateway.",
  },
  {
    slug: "gate",
    name: "Gate",
    category: "cex",
    status: "out_of_scope",
    tools: ["list_sui_defi_protocols"],
    sdk: { suiCompatibility: "not_applicable", notes: "Centralized exchange custody, not a Sui smart-contract adapter." },
    notes: "Read-only/out of scope for this onchain gateway.",
  },
];

export function listProtocolIntegrations(input: { slugs?: string[] } = {}) {
  if (!input.slugs?.length) return PROTOCOLS;
  return input.slugs.flatMap((slug) => {
    const protocol = protocolIntegrationForSlug(slug);
    return protocol ? [protocol] : [];
  });
}

export function listLiquidityProtocols() {
  return PROTOCOLS.filter((protocol) => protocol.category === "dex" || protocol.category === "vault" || protocol.category === "trading" || protocol.category === "derivatives");
}

export function protocolIntegrationForSlug(slug?: string) {
  if (!slug) return undefined;
  const normalized = slug.toLowerCase();
  return PROTOCOLS.find((protocol) => protocol.slug === normalized || protocol.name.toLowerCase().replaceAll(" ", "-") === normalized);
}
