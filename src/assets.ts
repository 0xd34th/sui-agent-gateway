export type TradableAssetCategory = "rwa_precious_metal";

export type TradableAsset = {
  symbol: string;
  name: string;
  category: TradableAssetCategory;
  issuer: string;
  coinType: string;
  decimals: number;
  aliases: string[];
  execution: "secondary_market_swap";
  tools: string[];
  notes: string;
};

export const TRADABLE_ASSETS: TradableAsset[] = [
  {
    symbol: "XAUM",
    name: "Matrixdock Gold",
    category: "rwa_precious_metal",
    issuer: "Matrixdock",
    coinType: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM",
    decimals: 9,
    aliases: ["gold", "matrixdock gold", "xaum", "xau m"],
    execution: "secondary_market_swap",
    tools: ["resolve_tradable_asset", "quote_all_swaps", "quote_swap", "execute_swap"],
    notes: "Trade through swap aggregators only. Matrixdock mint/redeem is not exposed because issuer flows may require KYC.",
  },
  {
    symbol: "XAGM",
    name: "Matrixdock Silver",
    category: "rwa_precious_metal",
    issuer: "Matrixdock",
    coinType: "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM",
    decimals: 9,
    aliases: ["silver", "matrixdock silver", "xagm", "xag m"],
    execution: "secondary_market_swap",
    tools: ["resolve_tradable_asset", "quote_all_swaps", "quote_swap", "execute_swap"],
    notes: "Trade through swap aggregators only. Matrixdock mint/redeem is not exposed because issuer flows may require KYC.",
  },
];

export function listTradableAssets(input: { category?: TradableAssetCategory; query?: string } = {}) {
  const query = normalize(input.query ?? "");
  return TRADABLE_ASSETS.filter((asset) => {
    if (input.category && asset.category !== input.category) return false;
    if (!query) return true;
    return searchableTerms(asset).some((term) => normalize(term).includes(query));
  });
}

export function resolveTradableAsset(input: { query: string }) {
  const query = normalize(input.query);
  const exact = TRADABLE_ASSETS.find((asset) => searchableTerms(asset).some((term) => normalize(term) === query));
  if (exact) return exact;
  const partial = TRADABLE_ASSETS.find((asset) => searchableTerms(asset).some((term) => normalize(term).includes(query)));
  if (partial) return partial;
  throw new Error(`No curated tradable asset found for "${input.query}"`);
}

function searchableTerms(asset: TradableAsset) {
  return [asset.symbol, asset.name, asset.coinType, ...asset.aliases];
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}
