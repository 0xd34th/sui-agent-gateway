import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.js";
import { PolicyStore } from "../src/policy.js";

const dirs: string[] = [];

function testConfig(): AppConfig {
  const homeDir = mkdtempSync(join(tmpdir(), "sui-agent-policy-"));
  dirs.push(homeDir);
  return {
    network: "testnet",
    rpcUrl: "https://fullnode.testnet.sui.io:443",
    homeDir,
    keystorePath: join(homeDir, "wallet.json"),
    policyPath: join(homeDir, "policy.json"),
    ledgerPath: join(homeDir, "ledger.json"),
    keystoreSecret: "test",
    allowMainnetWrites: false,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PolicyStore", () => {
  it("blocks paused wallets", () => {
    const store = new PolicyStore(testConfig());
    store.setPaused(true);

    expect(store.evaluate({ action: "send", amountMist: "1", coinType: "0x2::sui::SUI" })).toEqual({
      decision: "blocked",
      reasons: ["wallet is paused"],
    });
  });

  it("blocks per-action and daily spend cap violations", () => {
    const store = new PolicyStore(testConfig());
    store.update({ perActionSpendLimitMist: "100", dailySpendLimitMist: "150" });
    store.recordSpend("75");

    expect(store.evaluate({ action: "swap", amountMist: "101", coinType: "0x2::sui::SUI", provider: "7k" }).reasons).toEqual([
      "amount 101 exceeds per-action cap 100",
      "projected daily spend 176 exceeds cap 150",
    ]);
  });

  it("blocks disabled swap providers and high slippage", () => {
    const store = new PolicyStore(testConfig());
    store.update({ allowedSwapProviders: ["cetus"], maxSlippageBps: 50 });

    expect(store.evaluate({ action: "swap", amountMist: "1", coinType: "0x2::sui::SUI", provider: "7k", slippageBps: 75 }).reasons).toEqual([
      "swap provider 7k is not allowed",
      "slippage 75 bps exceeds policy max 50 bps",
    ]);
  });

  it("allows both implemented lending providers by default", () => {
    const store = new PolicyStore(testConfig());

    expect(store.evaluate({ action: "lending_supply", amountMist: "1", coinType: "0x2::sui::SUI", provider: "scallop" }).decision).toBe("allowed");
    expect(store.evaluate({ action: "lending_supply", amountMist: "1", coinType: "0x2::sui::SUI", provider: "suilend" }).decision).toBe("allowed");
  });

  it("allows real borrow and CDP borrow actions for implemented providers by default", () => {
    const store = new PolicyStore(testConfig());

    expect(store.evaluate({ action: "lending_borrow", provider: "suilend" }).decision).toBe("allowed");
    expect(store.evaluate({ action: "lending_borrow", provider: "scallop" }).decision).toBe("allowed");
    expect(store.evaluate({ action: "lending_borrow", provider: "navi" }).decision).toBe("blocked");
    expect(store.evaluate({ action: "cdp_borrow", provider: "bucket" }).decision).toBe("allowed");
  });
});
