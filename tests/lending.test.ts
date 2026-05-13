import { describe, expect, it } from "vitest";
import { LendingService } from "../src/lending.js";

describe("LendingService", () => {
  it("lists Scallop and Suilend as implemented real borrow providers", () => {
    const service = new LendingService({ network: "mainnet" } as never, {} as never, {} as never, {} as never);
    expect(service.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "scallop", status: "implemented" }),
        expect.objectContaining({ id: "navi", status: "adapter_needed" }),
        expect.objectContaining({ id: "suilend", status: "implemented" }),
      ]),
    );
  });

  it("does not pretend NAVI borrow can execute without a v2 adapter", async () => {
    const policy = { evaluate: () => ({ decision: "allowed", reasons: [] }) };
    const service = new LendingService({ network: "mainnet" } as never, {} as never, {} as never, policy as never);
    await expect(service.quoteBorrow({ provider: "navi", coin: "sui", amount: "1" })).resolves.toMatchObject({
      provider: "navi",
      executable: false,
      execution: "adapter_needed",
    });
  });

  it("does not pretend NAVI lending can execute yet", async () => {
    const service = new LendingService({ network: "mainnet" } as never, {} as never, {} as never, {} as never);
    await expect(service.listMarkets({ provider: "navi" })).resolves.toMatchObject({
      provider: "navi",
      executable: false,
      execution: "adapter_needed",
    });
  });
});
