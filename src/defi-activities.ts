import { protocolIntegrationForSlug } from "./protocols.js";

export type DefiActivityId =
  | "swap"
  | "native_stake"
  | "liquid_stake"
  | "lp_deposit"
  | "vault_deposit"
  | "rwa_swap"
  | "lending_supply"
  | "lending_borrow"
  | "cdp_deposit"
  | "cdp_mint"
  | "perps_trade";

const ACTIVITIES: Array<{
  id: DefiActivityId;
  label: string;
  status: "implemented" | "partially_implemented" | "planned" | "blocked_by_policy";
  tools: string[];
  policy: string;
}> = [
  {
    id: "swap",
    label: "Best-rate swaps",
    status: "implemented",
    tools: ["quote_all_swaps", "quote_swap", "execute_swap"],
    policy: "Spend caps, slippage caps, provider allowlist, token allowlist, dry-run support.",
  },
  {
    id: "native_stake",
    label: "Native SUI staking",
    status: "implemented",
    tools: ["quote_native_stake", "native_stake_sui", "native_unstake_sui", "get_native_stakes"],
    policy: "Stake minimum, active validator selection, preflight, spend caps.",
  },
  {
    id: "liquid_stake",
    label: "Liquid staking",
    status: "partially_implemented",
    tools: ["list_liquid_stake_providers", "quote_liquid_stake", "liquid_stake_sui", "liquid_unstake_sui"],
    policy: "Aftermath is native SDK-backed. Haedal can be routed as a swap-to-haSUI route when HAEDAL_HASUI_COIN_TYPE is configured.",
  },
  {
    id: "lp_deposit",
    label: "LP deposits and withdrawals",
    status: "planned",
    tools: ["get_defi_action_plan"],
    policy: "Pool allowlist, IL disclosure, share-token tracking, withdraw preflight.",
  },
  {
    id: "vault_deposit",
    label: "Vault deposits and withdrawals",
    status: "planned",
    tools: ["get_defi_action_plan"],
    policy: "Vault allowlist, strategy labels, share-price check, withdrawal constraints.",
  },
  {
    id: "rwa_swap",
    label: "Tokenized gold/silver swaps",
    status: "implemented",
    tools: ["list_tradable_assets", "resolve_tradable_asset", "quote_all_swaps", "quote_swap", "execute_swap"],
    policy: "Secondary-market swaps only. Matrixdock mint/redeem is not exposed because issuer flows may require KYC.",
  },
  {
    id: "lending_supply",
    label: "Lending supply/withdraw",
    status: "partially_implemented",
    tools: ["list_lending_providers", "list_lending_markets", "quote_lending_supply", "lending_supply", "quote_lending_withdraw", "lending_withdraw", "get_lending_positions"],
    policy: "Scallop and Suilend supply/withdraw use real SDK transactions. Spend caps and provider allowlists apply.",
  },
  {
    id: "lending_borrow",
    label: "Lending borrow/repay",
    status: "partially_implemented",
    tools: ["quote_lending_borrow", "lending_borrow"],
    policy: "Scallop and Suilend borrow use real SDK transactions when the wallet already has an obligation/collateral account. Other providers need adapters.",
  },
  {
    id: "cdp_mint",
    label: "CDP mint/repay",
    status: "partially_implemented",
    tools: ["quote_bucket_borrow_usdb", "bucket_borrow_usdb"],
    policy: "Bucket USDB borrow/mint uses the real manage-position SDK transaction with optional collateral deposit in the same transaction.",
  },
  {
    id: "cdp_deposit",
    label: "CDP collateral deposit/withdraw",
    status: "partially_implemented",
    tools: ["list_cdp_providers", "list_bucket_collateral_types", "quote_bucket_deposit_collateral", "bucket_deposit_collateral", "get_bucket_positions"],
    policy: "Bucket collateral deposit is SDK-backed. USDB borrow/mint is also wired through the Bucket manage-position SDK path.",
  },
  {
    id: "perps_trade",
    label: "Perpetuals trading",
    status: "planned",
    tools: ["get_defi_action_plan"],
    policy: "Real execution needs a protocol adapter, leverage cap, reduce-only default, and explicit user confirmation.",
  },
];

export class DefiActivityService {
  listActivities() {
    return ACTIVITIES;
  }

  getActionPlan(input: { protocolSlug?: string; category?: string; action?: DefiActivityId }) {
    const integration = protocolIntegrationForSlug(input.protocolSlug);
    const category = input.category ?? categoryForProtocol(input.protocolSlug);
    const activity = input.action ? ACTIVITIES.find((item) => item.id === input.action) : activityForCategory(category);
    return {
      protocolSlug: input.protocolSlug,
      protocolStatus: integration?.status,
      sdkCompatibility: integration?.sdk?.suiCompatibility,
      category,
      action: input.action ?? activity?.id,
      status: integration ? statusForProtocol(integration.status, activity?.status) : activity?.status ?? "planned",
      supportedNow: integration ? integration.status === "implemented" || integration.status === "partially_implemented" : activity?.status === "implemented" || activity?.status === "partially_implemented",
      tools: integration?.tools ?? activity?.tools ?? ["list_sui_defi_protocols"],
      policy: activity?.policy ?? "No adapter mapped yet.",
      nextAdapterWork: integration?.notes ?? nextAdapterWork(category, activity?.id),
    };
  }

}

function categoryForProtocol(slug?: string): string | undefined {
  if (!slug) return undefined;
  const integration = protocolIntegrationForSlug(slug);
  if (integration) return categoryLabel(integration.category);
  if (["navi-lending", "navi", "suilend", "alphalend", "scallop-lend", "scallop", "current"].includes(slug)) return "Lending";
  if (["springsui", "haedal-protocol", "volo-lst", "alphafi-stsui"].includes(slug)) return "Liquid Staking";
  if (["cetus-clmm", "bluefin-spot", "deepbook-v3", "momentum", "magma", "turbos", "turbos-finance"].includes(slug)) return "Dexs";
  if (["abyss", "abyss-protocol"].includes(slug)) return "Derivatives";
  if (["sudo-perps", "bluefin-pro"].includes(slug)) return "Derivatives";
  if (["bucket-cdp", "bucket-protocol-v2", "bucket"].includes(slug)) return "CDP";
  if (["alphafi-agg", "mole", "volo-vault", "ember-protocol"].includes(slug)) return "Yield Aggregator";
  if (["bucket-farm", "kai-finance"].includes(slug)) return "Farm";
  if (["kaio", "matrixdock", "matrixdock-xaum", "ondo-yield-assets", "xaum", "xagm"].includes(slug)) return "RWA";
  if (["bybit", "gate"].includes(slug)) return "CEX";
  return undefined;
}

function categoryLabel(category: NonNullable<ReturnType<typeof protocolIntegrationForSlug>>["category"]) {
  switch (category) {
    case "dex":
      return "Dexs";
    case "liquid_staking":
      return "Liquid Staking";
    case "cdp":
      return "CDP";
    case "rwa":
      return "RWA";
    case "farm":
      return "Farm";
    case "vault":
      return "Yield Aggregator";
    case "derivatives":
    case "trading":
      return "Derivatives";
    case "cex":
      return "CEX";
    case "leveraged_farming":
      return "Farm";
    case "yield":
      return "Yield Aggregator";
    default:
      return "Lending";
  }
}

function statusForProtocol(status: NonNullable<ReturnType<typeof protocolIntegrationForSlug>>["status"], fallback?: string) {
  if (status === "implemented") return "implemented";
  if (status === "partially_implemented") return "partially_implemented";
  if (status === "out_of_scope") return "blocked_by_policy";
  if (status === "adapter_needed" || status === "read_only") return "planned";
  return fallback ?? "planned";
}

function activityForCategory(category?: string) {
  switch (category) {
    case "Dexs":
      return ACTIVITIES.find((item) => item.id === "swap");
    case "Liquid Staking":
      return ACTIVITIES.find((item) => item.id === "liquid_stake");
    case "Lending":
      return ACTIVITIES.find((item) => item.id === "lending_supply");
    case "CDP":
      return ACTIVITIES.find((item) => item.id === "cdp_deposit");
    case "Derivatives":
      return ACTIVITIES.find((item) => item.id === "perps_trade");
    case "Farm":
      return ACTIVITIES.find((item) => item.id === "lp_deposit");
    case "Yield Aggregator":
    case "Risk Curators":
    case "Onchain Capital Allocator":
      return ACTIVITIES.find((item) => item.id === "vault_deposit");
    case "RWA":
      return ACTIVITIES.find((item) => item.id === "rwa_swap");
    default:
      return undefined;
  }
}

function nextAdapterWork(category?: string, activity?: DefiActivityId) {
  if (category === "RWA") return "XAUM and XAGM are curated as secondary-market swap assets. Issuer mint/redeem remains out of scope.";
  if (category === "Liquid Staking") return "Aftermath is executable; Haedal supports swap-to-LST once HAEDAL_HASUI_COIN_TYPE is configured. Native Haedal stake/unstake still needs verified PTB builder.";
  if (category === "Lending") return "Scallop and Suilend supply/withdraw/borrow are executable where obligation objects exist; next adapters are NAVI/AlphaLend.";
  if (category === "CDP") return "Bucket collateral deposit and USDB borrow/mint are executable through the real manage-position SDK path.";
  if (category === "Derivatives") return "Add collateral-only first, then reduce-only trading with leverage caps.";
  if (category === "Dexs") return "Swaps work via aggregators; LP needs pool-specific deposit/withdraw builders.";
  if (category === "CEX") return "No onchain adapter; show read-only status only.";
  return "Map protocol category to a safe activity adapter.";
}
