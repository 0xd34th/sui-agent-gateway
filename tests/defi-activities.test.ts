import { describe, expect, it } from "vitest";
import { DefiActivityService } from "../src/defi-activities.js";

describe("DefiActivityService", () => {
  it("lists activity status for broad DeFi surfaces", () => {
    const service = new DefiActivityService();
    expect(service.listActivities().map((activity) => activity.id)).not.toContain("buy_rwa");
    expect(service.getActionPlan({ protocolSlug: "navi-lending" })).toMatchObject({
      category: "Lending",
      action: "lending_supply",
      protocolStatus: "adapter_needed",
      supportedNow: false,
    });
    expect(service.getActionPlan({ protocolSlug: "suilend" })).toMatchObject({
      category: "Lending",
      action: "lending_supply",
      protocolStatus: "implemented",
      supportedNow: true,
    });
  });

  it("supports RWA through secondary-market swaps only", () => {
    const service = new DefiActivityService();
    expect(service.getActionPlan({ category: "RWA" })).toMatchObject({
      category: "RWA",
      action: "rwa_swap",
      status: "implemented",
      supportedNow: true,
      nextAdapterWork: expect.stringContaining("XAUM and XAGM"),
    });
  });
});
