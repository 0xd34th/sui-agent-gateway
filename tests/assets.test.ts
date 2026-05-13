import { describe, expect, it } from "vitest";
import { listTradableAssets, resolveTradableAsset } from "../src/assets.js";

describe("tradable asset catalog", () => {
  it("resolves Matrixdock gold and silver into Sui coin types", () => {
    expect(resolveTradableAsset({ query: "gold" })).toMatchObject({
      symbol: "XAUM",
      coinType: "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM",
      execution: "secondary_market_swap",
    });
    expect(resolveTradableAsset({ query: "xagm" })).toMatchObject({
      symbol: "XAGM",
      coinType: "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM",
      execution: "secondary_market_swap",
    });
  });

  it("lists tokenized precious metals as normal swap assets", () => {
    const assets = listTradableAssets({ category: "rwa_precious_metal" });
    expect(assets.map((asset) => asset.symbol)).toEqual(["XAUM", "XAGM"]);
    expect(assets.every((asset) => asset.tools.includes("quote_all_swaps"))).toBe(true);
  });
});
