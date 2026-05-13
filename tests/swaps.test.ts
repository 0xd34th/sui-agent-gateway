import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config.js";
import { Keystore } from "../src/keystore.js";
import { PolicyStore } from "../src/policy.js";
import { SwapService } from "../src/swaps.js";

const dirs: string[] = [];

function makeService() {
  const homeDir = mkdtempSync(join(tmpdir(), "sui-agent-swaps-"));
  dirs.push(homeDir);
  const config: AppConfig = {
    network: "testnet",
    rpcUrl: "https://fullnode.testnet.sui.io:443",
    homeDir,
    keystorePath: join(homeDir, "wallet.json"),
    policyPath: join(homeDir, "policy.json"),
    ledgerPath: join(homeDir, "ledger.json"),
    keystoreSecret: "test",
    allowMainnetWrites: false,
  };
  return new SwapService(config, {} as never, new Keystore(config), new PolicyStore(config));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SEVENK_QUOTE_URL;
  delete process.env.AFTERMATH_QUOTE_URL;
  delete process.env.CETUS_QUOTE_URL;
  delete process.env.SEVENK_API_URL;
  delete process.env.AFTERMATH_API_URL;
  delete process.env.CETUS_API_URL;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SwapService", () => {
  it("ranks all provider quotes by net output", async () => {
    process.env.SEVENK_QUOTE_URL = "https://quotes.test/7k";
    process.env.AFTERMATH_QUOTE_URL = "https://quotes.test/aftermath";
    process.env.CETUS_QUOTE_URL = "https://quotes.test/cetus";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => ({
          expectedAmountOut: url.includes("aftermath") ? "1050" : url.includes("cetus") ? "1030" : "1000",
          estimatedGasMist: url.includes("aftermath") ? "10" : "0",
        }),
      })),
    );

    const result = await makeService().quoteAll({
      coinInType: "0x2::sui::SUI",
      coinOutType: "0xabc::coin::COIN",
      amountIn: "1",
    });

    expect(result.quotes.map((quote) => quote.provider)).toEqual(["aftermath", "cetus", "7k"]);
    expect(result.failures).toEqual([]);
  });

  it("returns a manual provider quote", async () => {
    process.env.CETUS_QUOTE_URL = "https://quotes.test/cetus";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ expectedAmountOut: "42", routeSummary: "cetus direct" }),
      })),
    );

    const quote = await makeService().quoteOne("cetus", {
      coinInType: "0x2::sui::SUI",
      coinOutType: "0xabc::coin::COIN",
      amountIn: "0.5",
    });

    expect(quote.provider).toBe("cetus");
    expect(quote.amountIn).toBe("500000000");
    expect(quote.expectedAmountOut).toBe("42");
  });
});
