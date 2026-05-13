import { createServer, Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(__dirname, "..");
let homeDir: string;
let quoteServer: Server;
let quoteBaseUrl: string;
let client: Client | null = null;
let transport: StdioClientTransport | null = null;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "sui-agent-mcp-"));
  quoteServer = createServer((req, res) => {
    const url = req.url ?? "";
    const expectedAmountOut = url.includes("aftermath") ? "2000" : url.includes("cetus") ? "1500" : "1000";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ expectedAmountOut, estimatedGasMist: "10", routeSummary: url.slice(1) }));
  });
  await new Promise<void>((resolveListen) => quoteServer.listen(0, "127.0.0.1", resolveListen));
  const address = quoteServer.address();
  if (!address || typeof address === "string") throw new Error("quote server failed to bind");
  quoteBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  await new Promise<void>((resolveClose) => quoteServer.close(() => resolveClose()));
  rmSync(homeDir, { recursive: true, force: true });
});

async function connectClient() {
  client = new Client({ name: "mcp-flow-test", version: "0.1.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      SUI_NETWORK: "testnet",
      SUI_AGENT_HOME: homeDir,
      SUI_AGENT_KEYSTORE_SECRET: "integration-test-secret",
      SEVENK_QUOTE_URL: `${quoteBaseUrl}/7k`,
      AFTERMATH_QUOTE_URL: `${quoteBaseUrl}/aftermath`,
      CETUS_QUOTE_URL: `${quoteBaseUrl}/cetus`,
    },
  });
  await client.connect(transport);
  return client;
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content?.[0];
  if (!content || content.type !== "text") throw new Error("expected text result");
  return JSON.parse(content.text);
}

describe("MCP whole flow", () => {
  it("creates a wallet, exposes receive info, updates policy, and ranks swap quotes", async () => {
    const mcp = await connectClient();
    const tools = await mcp.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "create_agent_wallet",
        "receive",
        "send",
        "resolve_suins_name",
        "quote_all_swaps",
        "execute_swap",
        "list_tradable_assets",
        "resolve_tradable_asset",
        "quote_native_stake",
        "native_stake_sui",
      ]),
    );

    const wallet = toolJson(await mcp.callTool({ name: "create_agent_wallet", arguments: {} }));
    expect(wallet.created).toBe(true);
    expect(wallet.network).toBe("testnet");
    expect(wallet.address).toMatch(/^0x[0-9a-f]{64}$/);

    const receive = toolJson(await mcp.callTool({ name: "receive", arguments: {} }));
    expect(receive.address).toBe(wallet.address);
    expect(receive.uri).toBe(`sui:${wallet.address}`);

    const updatedPolicy = toolJson(
      await mcp.callTool({
        name: "update_policy",
        arguments: { perActionSpendLimitMist: "2000000000", dailySpendLimitMist: "3000000000", maxSlippageBps: 75 },
      }),
    );
    expect(updatedPolicy.maxSlippageBps).toBe(75);

    const gold = toolJson(await mcp.callTool({ name: "resolve_tradable_asset", arguments: { query: "gold" } }));
    expect(gold.symbol).toBe("XAUM");
    expect(gold.coinType).toContain("::xaum::XAUM");

    const quotes = toolJson(
      await mcp.callTool({
        name: "quote_all_swaps",
        arguments: {
          coinInType: "0x2::sui::SUI",
          coinOutType: "0xabc::coin::COIN",
          amountIn: "1",
        },
      }),
    );
    expect(quotes.failures).toEqual([]);
    expect(quotes.quotes.map((quote: { provider: string }) => quote.provider)).toEqual(["aftermath", "cetus", "7k"]);

    const blockedSend = toolJson(
      await mcp.callTool({
        name: "send",
        arguments: {
          recipient: "0x0000000000000000000000000000000000000000000000000000000000000002",
          amount: "3",
          dryRun: true,
        },
      }),
    );
    expect(blockedSend.policy.decision).toBe("blocked");
    expect(blockedSend.policy.reasons).toContain("amount 3000000000 exceeds per-action cap 2000000000");
  }, 15_000);
});
