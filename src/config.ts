import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

export type AppConfig = {
  network: SuiNetwork;
  rpcUrl: string;
  homeDir: string;
  keystorePath: string;
  policyPath: string;
  ledgerPath: string;
  keystoreSecret: string;
  allowMainnetWrites: boolean;
};

function readNetwork(): SuiNetwork {
  loadDotEnv();
  const network = process.env.SUI_NETWORK ?? "mainnet";
  if (network === "mainnet" || network === "testnet" || network === "devnet" || network === "localnet") {
    return network;
  }

  throw new Error(`Unsupported SUI_NETWORK "${network}"`);
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  const network = readNetwork();
  const homeDir = resolve(process.env.SUI_AGENT_HOME ?? ".sui-agent-gateway");
  mkdirSync(homeDir, { recursive: true });

  return {
    network,
    rpcUrl: process.env.SUI_GRPC_URL ?? process.env.SUI_RPC_URL ?? getGrpcFullnodeUrl(network),
    homeDir,
    keystorePath: join(homeDir, "wallet.json"),
    policyPath: join(homeDir, "policy.json"),
    ledgerPath: join(homeDir, "spend-ledger.json"),
    keystoreSecret: process.env.SUI_AGENT_KEYSTORE_SECRET ?? "local-dev-secret-change-me",
    allowMainnetWrites: process.env.SUI_AGENT_ENABLE_MAINNET_WRITES === "true",
  };
}

function loadDotEnv(): void {
  const path = resolve(".env");
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function getGrpcFullnodeUrl(network: SuiNetwork): string {
  switch (network) {
    case "mainnet":
      return "https://fullnode.mainnet.sui.io:443";
    case "testnet":
      return "https://fullnode.testnet.sui.io:443";
    case "devnet":
      return "https://fullnode.devnet.sui.io:443";
    case "localnet":
      return "http://127.0.0.1:9000";
  }
}
