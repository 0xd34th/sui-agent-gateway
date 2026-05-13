import { protocolIntegrationForSlug } from "./protocols.js";

export type SuiDefiProtocol = {
  rank: number;
  name: string;
  slug: string;
  category: string;
  suiTvlUsd: number;
  activity: string;
  integrationStatus: "supported" | "adapter_needed" | "read_only" | "out_of_scope";
  notes: string;
  tools: string[];
  sdkCompatibility?: string;
};

type DefiLlamaProtocol = {
  name?: string;
  slug?: string;
  category?: string;
  chains?: string[];
  chainTvls?: Record<string, number>;
  tvl?: number;
};

const CATEGORY_ACTIVITY: Record<string, Pick<SuiDefiProtocol, "activity" | "integrationStatus" | "notes">> = {
  Dexs: {
    activity: "swap, route, LP",
    integrationStatus: "supported",
    notes: "Swaps are covered through 7K, Aftermath, and Cetus aggregators. LP needs pool-specific adapters.",
  },
  "Liquid Staking": {
    activity: "liquid stake, liquid unstake",
    integrationStatus: "adapter_needed",
    notes: "Native staking is supported. Add LST adapters for SpringSui, Haedal, Volo, and AlphaFi stSUI.",
  },
  RWA: {
    activity: "secondary-market swap",
    integrationStatus: "supported",
    notes: "XAUM and XAGM are curated as normal swap assets. Issuer mint/redeem is out of scope because those flows may require KYC.",
  },
  Lending: {
    activity: "supply, withdraw, borrow, repay",
    integrationStatus: "supported",
    notes: "Scallop and Suilend supply/withdraw are implemented. Other lending adapters still need SDK/PTB work; borrow stays disabled by default.",
  },
  Farm: {
    activity: "deposit farm, withdraw farm, harvest",
    integrationStatus: "adapter_needed",
    notes: "Requires reward-token disclosure, lockup handling, and pool allowlists.",
  },
  "Yield Aggregator": {
    activity: "deposit vault, withdraw vault",
    integrationStatus: "adapter_needed",
    notes: "Requires vault strategy metadata, share-price simulation, and withdrawal constraints.",
  },
  "Risk Curators": {
    activity: "deposit curated vault, withdraw curated vault",
    integrationStatus: "adapter_needed",
    notes: "Treat like vaults with curator and strategy risk labels.",
  },
  CDP: {
    activity: "mint, repay, collateral deposit, collateral withdraw",
    integrationStatus: "adapter_needed",
    notes: "Requires health-factor policy and borrow/mint disabled by default.",
  },
  Derivatives: {
    activity: "perps trade, collateral deposit, collateral withdraw",
    integrationStatus: "adapter_needed",
    notes: "High-risk. Needs leverage caps, reduce-only defaults, and explicit user confirmation.",
  },
  CEX: {
    activity: "centralized exchange custody",
    integrationStatus: "out_of_scope",
    notes: "Not a Sui DeFi smart-contract adapter.",
  },
};

export async function listSuiDefiProtocols(limit = 30): Promise<SuiDefiProtocol[]> {
  const response = await fetch("https://api.llama.fi/protocols");
  if (!response.ok) throw new Error(`DeFiLlama protocols request failed: ${response.status} ${await response.text()}`);
  const protocols = (await response.json()) as DefiLlamaProtocol[];

  return protocols
    .filter((protocol) => protocol.chains?.includes("Sui"))
    .map((protocol) => ({
      name: protocol.name ?? "",
      slug: protocol.slug ?? "",
      category: protocol.category ?? "Unknown",
      suiTvlUsd: Number(protocol.chainTvls?.Sui ?? 0),
    }))
    .filter((protocol) => protocol.suiTvlUsd > 0)
    .sort((a, b) => b.suiTvlUsd - a.suiTvlUsd)
    .slice(0, limit)
    .map((protocol, index) => {
      const mapping = CATEGORY_ACTIVITY[protocol.category] ?? {
        activity: "inspect",
        integrationStatus: "read_only" as const,
        notes: "No execution adapter mapped yet.",
      };
      const integration = protocolIntegrationForSlug(protocol.slug);
      if (integration) {
        return {
          rank: index + 1,
          ...protocol,
          activity: activityForIntegration(integration.category, protocol.category),
          integrationStatus: statusForIntegration(integration.status),
          notes: integration.notes,
          tools: integration.tools,
          sdkCompatibility: integration.sdk?.suiCompatibility,
        };
      }
      return {
        rank: index + 1,
        ...protocol,
        ...mapping,
        tools: [],
      };
    });
}

function statusForIntegration(status: NonNullable<ReturnType<typeof protocolIntegrationForSlug>>["status"]): SuiDefiProtocol["integrationStatus"] {
  if (status === "implemented" || status === "partially_implemented") return "supported";
  if (status === "adapter_needed") return "adapter_needed";
  if (status === "out_of_scope") return "out_of_scope";
  return "read_only";
}

function activityForIntegration(category: NonNullable<ReturnType<typeof protocolIntegrationForSlug>>["category"], fallbackCategory: string) {
  switch (category) {
    case "dex":
      return "swap, route";
    case "lending":
      return "supply, withdraw";
    case "liquid_staking":
      return "liquid stake, liquid unstake";
    case "cdp":
      return "collateral deposit, collateral status";
    case "rwa":
      return "secondary-market swap";
    case "farm":
      return "farm deposit, withdraw, harvest";
    case "vault":
    case "yield":
      return "vault deposit, withdraw";
    case "derivatives":
    case "trading":
      return "collateral/trading adapter";
    case "cex":
      return "centralized exchange custody";
    default:
      return CATEGORY_ACTIVITY[fallbackCategory]?.activity ?? "inspect";
  }
}
