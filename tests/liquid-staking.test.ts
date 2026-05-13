import { describe, expect, it } from "vitest";
import { LiquidStakingService } from "../src/liquid-staking.js";

describe("LiquidStakingService", () => {
  it("lists Aftermath as implemented and other LST providers as adapter-needed", () => {
    const service = new LiquidStakingService({ network: "mainnet" } as never, {} as never, {} as never, {} as never);
    expect(service.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "aftermath", status: "implemented", receiptAsset: "afSUI" }),
        expect.objectContaining({ id: "haedal", status: "adapter_needed", receiptAsset: "haSUI" }),
        expect.objectContaining({ id: "volo", status: "adapter_needed", receiptAsset: "vSUI" }),
      ]),
    );
  });

  it("does not pretend non-implemented providers are executable", async () => {
    const policy = { evaluate: () => ({ decision: "allowed", reasons: [] }) };
    const service = new LiquidStakingService({ network: "mainnet" } as never, {} as never, {} as never, policy as never);
    await expect(service.quoteStake({ amountSui: "1", provider: "volo" })).resolves.toMatchObject({
      provider: "volo",
      executable: false,
      execution: "adapter_needed",
    });
  });

  it("surfaces Haedal as a secondary-market haSUI route until native PTBs are verified", async () => {
    const previous = process.env.HAEDAL_HASUI_COIN_TYPE;
    process.env.HAEDAL_HASUI_COIN_TYPE = "0xexample::hasui::HASUI";
    const policy = { evaluate: () => ({ decision: "allowed", reasons: [] }) };
    const service = new LiquidStakingService({ network: "mainnet" } as never, {} as never, {} as never, policy as never);
    await expect(service.quoteStake({ amountSui: "1", provider: "haedal" })).resolves.toMatchObject({
      provider: "haedal",
      executable: false,
      execution: "swap_route_available",
      receiptCoinType: "0xexample::hasui::HASUI",
    });

    if (previous === undefined) delete process.env.HAEDAL_HASUI_COIN_TYPE;
    else process.env.HAEDAL_HASUI_COIN_TYPE = previous;
  });
});
