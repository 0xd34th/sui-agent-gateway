import { describe, expect, it } from "vitest";
import { CdpService } from "../src/cdp.js";

describe("CdpService", () => {
  it("lists Bucket as partially implemented and keeps Kai as adapter-needed", () => {
    const service = new CdpService({ network: "mainnet" } as never, {} as never, {} as never, {} as never);
    expect(service.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bucket", status: "partially_implemented" }),
        expect.objectContaining({ id: "kai-finance", status: "adapter_needed" }),
      ]),
    );
  });

  it("quotes Bucket USDB borrowing as a real SDK transaction path", async () => {
    const policy = { evaluate: () => ({ decision: "allowed", reasons: [] }) };
    const service = new CdpService(
      { network: "mainnet" } as never,
      { getCoinMetadata: async () => ({ coinMetadata: { decimals: 9 } }) } as never,
      {} as never,
      policy as never,
    );
    service.listBucketCollateralTypes = async () => [{ provider: "bucket", coinType: "0x2::sui::SUI", price: 1, vault: {} }] as never;
    await expect(service.quoteBucketBorrow({ coinType: "0x2::sui::SUI", borrowAmount: "1", depositAmount: "2" })).resolves.toMatchObject({
      provider: "bucket",
      executable: true,
      execution: "sdk",
      borrowAmountBaseUnits: "1000000",
      depositAmountBaseUnits: "2000000000",
    });
  });
});
