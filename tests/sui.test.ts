import { describe, expect, it } from "vitest";
import { parseSuiToMist, parseUnitsDecimal, SuiWalletService } from "../src/sui.js";

describe("amount parsing", () => {
  it("parses SUI to MIST", () => {
    expect(parseSuiToMist("1.25")).toBe("1250000000");
    expect(parseSuiToMist("0.000000001")).toBe("1");
  });

  it("rejects too many decimals", () => {
    expect(() => parseUnitsDecimal("1.123", 2)).toThrow("more than 2 decimals");
  });
});

describe("SuiWalletService", () => {
  it("builds a SUI send transaction without provider RPC", async () => {
    const service = new SuiWalletService({ network: "testnet" } as never, {} as never, {} as never, {} as never);
    const tx = await service.buildSendTransaction({
      sender: "0x0000000000000000000000000000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000000000000000000000000000002",
      coinType: "0x2::sui::SUI",
      amountBaseUnits: "1000",
    });

    expect(tx.getData().commands).toHaveLength(2);
  });

  it("builds a native stake transaction without looking up off-chain limits", () => {
    const service = new SuiWalletService({ network: "testnet" } as never, {} as never, {} as never, {} as never);
    const tx = service.buildNativeStakeTransaction({
      sender: "0x0000000000000000000000000000000000000000000000000000000000000001",
      validatorAddress: "0x0000000000000000000000000000000000000000000000000000000000000002",
      amountMist: "2000000",
    });

    expect(tx.getData().commands).toHaveLength(2);
  });
});
