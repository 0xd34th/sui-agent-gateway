import { randomUUID } from "node:crypto";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";
import { AggregatorClient, Env, type RouterDataV3 } from "@cetusprotocol/aggregator-sdk";
import { buildTx as buildSevenKTx, Config as SevenKConfig, getQuote as getSevenKQuote } from "@bluefin-exchange/bluefin7k-aggregator-sdk";
import { Aftermath, type RouterCompleteTradeRoute } from "aftermath-ts-sdk";
import { AppConfig } from "./config.js";
import { Keystore } from "./keystore.js";
import { PolicyStore } from "./policy.js";
import { RankedSwapQuote, SUI_COIN_TYPE, SwapProviderId, SwapQuote } from "./types.js";
import { parseSuiToMist } from "./sui.js";

export type QuoteRequest = {
  coinInType: string;
  coinOutType: string;
  amountIn: string;
  amountIsBaseUnits?: boolean;
  slippageBps?: number;
};

type ProviderConfig = {
  id: SwapProviderId;
  name: string;
  envUrl: string;
  legacyEnvUrl?: string;
  apiKeyEnv?: string;
  defaultUrl?: string;
};

type CetusSdkQuoteRaw = {
  kind: "cetus-sdk";
  router: RouterDataV3;
};

type AftermathSdkQuoteRaw = {
  kind: "aftermath-sdk";
  route: RouterCompleteTradeRoute;
};

type SevenKQuoteResponse = {
  swapAmountWithDecimal?: string;
  returnAmountWithDecimal?: string;
  returnAmountAfterCommissionWithDecimal?: string;
  priceImpact?: number | null;
  routes?: Array<{ hops?: Array<{ pool?: { type?: string } }> }>;
  swaps?: Array<{ functionName?: string }>;
  warning?: string;
};

type SevenKSdkQuoteRaw = {
  kind: "7k-sdk";
  quote: SevenKQuoteResponse;
};

const PROVIDERS: ProviderConfig[] = [
  { id: "7k", name: "7K Aggregator", envUrl: "SEVENK_QUOTE_URL", legacyEnvUrl: "SEVENK_API_URL", apiKeyEnv: "SEVENK_API_KEY" },
  { id: "aftermath", name: "Aftermath Router", envUrl: "AFTERMATH_QUOTE_URL", legacyEnvUrl: "AFTERMATH_API_URL", apiKeyEnv: "AFTERMATH_API_KEY" },
  {
    id: "cetus",
    name: "Cetus Aggregator V3",
    envUrl: "CETUS_QUOTE_URL",
    legacyEnvUrl: "CETUS_API_URL",
    apiKeyEnv: "CETUS_API_KEY",
    defaultUrl: "https://api-sui.cetus.zone/router_v3/find_routes",
  },
];

export class SwapService {
  private readonly quotes = new Map<string, SwapQuote>();

  constructor(
    private readonly config: AppConfig,
    private readonly client: SuiGrpcClient,
    private readonly keystore: Keystore,
    private readonly policy: PolicyStore,
  ) {}

  listProviders() {
    const policy = this.policy.get();
    return PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabledByPolicy: policy.allowedSwapProviders.includes(provider.id),
      configured: Boolean(this.providerUrl(provider)) || this.hasSdkAdapter(provider.id),
      endpoint: process.env[provider.envUrl]
        ? "custom"
        : provider.legacyEnvUrl && process.env[provider.legacyEnvUrl]
          ? "custom_legacy"
          : this.hasSdkAdapter(provider.id)
            ? "sdk"
            : provider.defaultUrl
              ? "default"
              : "not_configured",
      env: provider.envUrl,
      apiKeyEnv: provider.apiKeyEnv,
    }));
  }

  async quoteAll(input: QuoteRequest): Promise<{ quotes: RankedSwapQuote[]; failures: { provider: SwapProviderId; error: string }[] }> {
    const slippageBps = input.slippageBps ?? this.policy.get().maxSlippageBps;
    const amountIn = this.normalizeAmount(input);
    const enabled = PROVIDERS.filter((provider) => this.policy.get().allowedSwapProviders.includes(provider.id));
    const results = await Promise.allSettled(
      enabled.map(async (provider) => this.quoteProvider(provider, { ...input, amountIn, amountIsBaseUnits: true, slippageBps })),
    );

    const quotes: SwapQuote[] = [];
    const failures: { provider: SwapProviderId; error: string }[] = [];
    results.forEach((result, index) => {
      const provider = enabled[index];
      if (result.status === "fulfilled") quotes.push(result.value);
      else failures.push({ provider: provider.id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    });

    return { quotes: this.rankQuotes(quotes), failures };
  }

  async quoteOne(providerId: SwapProviderId, input: QuoteRequest): Promise<SwapQuote> {
    const provider = PROVIDERS.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown swap provider ${providerId}`);
    return this.quoteProvider(provider, {
      ...input,
      amountIn: this.normalizeAmount(input),
      amountIsBaseUnits: true,
      slippageBps: input.slippageBps ?? this.policy.get().maxSlippageBps,
    });
  }

  async execute(input: QuoteRequest & { provider?: SwapProviderId; quoteId?: string; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = input.quoteId
      ? this.quotes.get(input.quoteId)
      : input.provider
        ? await this.quoteOne(input.provider, input)
        : (await this.quoteAll(input)).quotes[0];

    if (!quote) throw new Error("No executable quote found");
    const mistImpact = quote.coinInType === SUI_COIN_TYPE ? quote.amountIn : "0";
    const decision = this.policy.evaluate({
      action: "swap",
      amountMist: mistImpact,
      coinType: quote.coinInType,
      provider: quote.provider,
      slippageBps: quote.slippageBps,
    });
    if (decision.decision === "blocked") return { policy: decision, quote };

    if (isCetusSdkQuoteRaw(quote.raw)) {
      return this.executeCetusSdkQuote(quote, decision, input.dryRun);
    }
    if (isAftermathSdkQuoteRaw(quote.raw)) {
      return this.executeAftermathSdkQuote(quote, decision, input.dryRun);
    }
    if (isSevenKSdkQuoteRaw(quote.raw)) {
      return this.executeSevenKSdkQuote(quote, decision, input.dryRun);
    }

    const txBytes = extractTransactionBytes(quote.raw);
    if (!txBytes) {
      return {
        policy: decision,
        quote,
        executable: false,
        reason:
          "This adapter returned a quote but no transaction bytes. Configure the provider endpoint to return transactionBytes/txBytes, or add a provider-specific SDK transaction builder.",
      };
    }

    if (input.dryRun) return { policy: decision, quote, executable: true, transactionBytes: txBytes };
    const signer = this.keystore.load();
    const transaction = Buffer.from(txBytes, "base64");
    const signature = await signer.signTransaction(transaction);
    const result = await this.client.executeTransaction({
      transaction,
      signatures: [signature.signature],
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    this.policy.recordSpend(mistImpact);
    const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return {
      policy: decision,
      quote,
      executable: true,
      digest: executed.digest,
      result,
    };
  }

  private async quoteProvider(provider: ProviderConfig, input: QuoteRequest & { amountIsBaseUnits: true; slippageBps: number }): Promise<SwapQuote> {
    const policy = this.policy.evaluate({
      action: "swap",
      amountMist: input.coinInType === SUI_COIN_TYPE ? input.amountIn : "0",
      coinType: input.coinInType,
      provider: provider.id,
      slippageBps: input.slippageBps,
    });
    if (policy.decision === "blocked") throw new Error(policy.reasons.join("; "));

    if (provider.id === "cetus" && !process.env[provider.envUrl] && !(provider.legacyEnvUrl && process.env[provider.legacyEnvUrl])) {
      return this.quoteCetusSdk(provider, input);
    }
    if (provider.id === "aftermath" && !process.env[provider.envUrl] && !(provider.legacyEnvUrl && process.env[provider.legacyEnvUrl])) {
      return this.quoteAftermathSdk(provider, input);
    }
    if (provider.id === "7k" && !process.env[provider.envUrl] && !(provider.legacyEnvUrl && process.env[provider.legacyEnvUrl])) {
      return this.quoteSevenKSdk(provider, input);
    }

    const url = this.providerUrl(provider);
    if (!url) {
      throw new Error(`${provider.name} endpoint is not configured. Set ${provider.envUrl}.`);
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: provider.id,
        network: this.config.network,
        coinInType: input.coinInType,
        coinOutType: input.coinOutType,
        amountIn: input.amountIn,
        slippageBps: input.slippageBps,
        sender: this.keystore.getAddress(),
      }),
    });
    if (!response.ok) {
      throw new Error(`${provider.name} quote failed: ${response.status} ${await response.text()}`);
    }
    const raw = await response.json();
    const expectedAmountOut = extractString(raw, ["expectedAmountOut", "amountOut", "returnAmount", "toAmount", "estimatedAmountOut"]);
    if (!expectedAmountOut) throw new Error(`${provider.name} response did not include an output amount`);

    const quote: SwapQuote = {
      quoteId: randomUUID(),
      provider: provider.id,
      providerName: provider.name,
      coinInType: input.coinInType,
      coinOutType: input.coinOutType,
      amountIn: input.amountIn,
      expectedAmountOut,
      minAmountOut: extractString(raw, ["minAmountOut", "minimumAmountOut"]),
      estimatedGasMist: extractString(raw, ["estimatedGasMist", "gas", "gasFee"]),
      priceImpactBps: extractNumber(raw, ["priceImpactBps", "priceImpact"]),
      slippageBps: input.slippageBps,
      routeSummary: extractString(raw, ["routeSummary", "route", "path"]) ?? provider.name,
      raw,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  private async quoteSevenKSdk(provider: ProviderConfig, input: QuoteRequest & { amountIsBaseUnits: true; slippageBps: number }): Promise<SwapQuote> {
    this.setupSevenKSdk(provider);
    const raw = (await getSevenKQuote({
      tokenIn: input.coinInType,
      tokenOut: input.coinOutType,
      amountIn: input.amountIn,
      taker: this.keystore.getAddress() ?? undefined,
      isSponsored: true,
    })) as SevenKQuoteResponse;
    const expectedAmountOut = raw.returnAmountAfterCommissionWithDecimal || raw.returnAmountWithDecimal;
    if (!expectedAmountOut) throw new Error("7K SDK response did not include an output amount");

    const quote: SwapQuote = {
      quoteId: randomUUID(),
      provider: provider.id,
      providerName: provider.name,
      coinInType: input.coinInType,
      coinOutType: input.coinOutType,
      amountIn: raw.swapAmountWithDecimal ?? input.amountIn,
      expectedAmountOut,
      priceImpactBps: typeof raw.priceImpact === "number" ? Math.round(raw.priceImpact * 10_000) : undefined,
      slippageBps: input.slippageBps,
      routeSummary: summarizeSevenKRoute(raw),
      raw: { kind: "7k-sdk", quote: raw } satisfies SevenKSdkQuoteRaw,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  private async quoteAftermathSdk(provider: ProviderConfig, input: QuoteRequest & { amountIsBaseUnits: true; slippageBps: number }): Promise<SwapQuote> {
    const aftermath = new Aftermath(this.config.network === "testnet" ? "TESTNET" : "MAINNET");
    await aftermath.init();
    const route = await aftermath.Router().getCompleteTradeRouteGivenAmountIn({
      coinInType: input.coinInType,
      coinOutType: input.coinOutType,
      coinInAmount: BigInt(input.amountIn),
    });

    const quote: SwapQuote = {
      quoteId: randomUUID(),
      provider: provider.id,
      providerName: provider.name,
      coinInType: route.coinIn.type,
      coinOutType: route.coinOut.type,
      amountIn: route.coinIn.amount.toString(),
      expectedAmountOut: route.coinOut.amount.toString(),
      slippageBps: input.slippageBps,
      routeSummary: summarizeAftermathRoute(route),
      raw: { kind: "aftermath-sdk", route } satisfies AftermathSdkQuoteRaw,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  private providerUrl(provider: ProviderConfig): string | undefined {
    return process.env[provider.envUrl] ?? (provider.legacyEnvUrl ? process.env[provider.legacyEnvUrl] : undefined) ?? provider.defaultUrl;
  }

  private async quoteCetusSdk(provider: ProviderConfig, input: QuoteRequest & { amountIsBaseUnits: true; slippageBps: number }): Promise<SwapQuote> {
    const signer = this.keystore.getAddress();
    const aggregator = new AggregatorClient({
      env: this.config.network === "testnet" ? Env.Testnet : Env.Mainnet,
      signer: signer ?? undefined,
      apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
    });
    const router = await aggregator.findRouters({
      from: input.coinInType,
      target: input.coinOutType,
      amount: input.amountIn,
      byAmountIn: true,
    });
    if (!router) throw new Error("Cetus Aggregator SDK returned no router");
    if (router.error) throw new Error(`${router.error.code}: ${router.error.msg}`);
    if (router.insufficientLiquidity) throw new Error("Cetus Aggregator SDK reported insufficient liquidity");

    const quote: SwapQuote = {
      quoteId: randomUUID(),
      provider: provider.id,
      providerName: provider.name,
      coinInType: input.coinInType,
      coinOutType: input.coinOutType,
      amountIn: router.amountIn.toString(),
      expectedAmountOut: router.amountOut.toString(),
      slippageBps: input.slippageBps,
      routeSummary: router.paths.map((path) => path.provider).join(" -> "),
      raw: { kind: "cetus-sdk", router } satisfies CetusSdkQuoteRaw,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  private async executeCetusSdkQuote(quote: SwapQuote, policy: unknown, dryRun?: boolean) {
    const raw = quote.raw as CetusSdkQuoteRaw;
    const signer = this.keystore.load();
    const address = signer.toSuiAddress();
    const aggregator = new AggregatorClient({
      env: this.config.network === "testnet" ? Env.Testnet : Env.Mainnet,
      signer: address,
    });
    const tx = new Transaction();
    tx.setSender(address);
    const inputCoin = await this.buildSwapInputCoin(tx, address, quote.coinInType, quote.amountIn);
    const outputCoin = await aggregator.routerSwap({
      router: raw.router,
      inputCoin,
      slippage: quote.slippageBps / 10_000,
      txb: tx,
    });
    tx.transferObjects([outputCoin], address);

    const simulation = await this.client.simulateTransaction({
      transaction: await tx.build({ client: this.client }),
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    if (dryRun) return { policy, quote, executable: true, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    this.policy.recordSpend(quote.coinInType === SUI_COIN_TYPE ? quote.amountIn : "0");
    const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { policy, quote, executable: true, digest: executed.digest, result };
  }

  private async buildSwapInputCoin(tx: Transaction, owner: string, coinType: string, amount: string) {
    if (isSuiCoinType(coinType)) {
      const [inputCoin] = tx.splitCoins(tx.gas, [BigInt(amount)]);
      return inputCoin;
    }

    const coins = await this.client.listCoins({ owner, coinType });
    let total = 0n;
    const selected: string[] = [];
    for (const coin of coins.objects) {
      selected.push(coin.objectId);
      total += BigInt(coin.balance);
      if (total >= BigInt(amount)) break;
    }
    if (total < BigInt(amount)) throw new Error(`Insufficient ${coinType} balance`);

    const [primary, ...rest] = selected;
    if (rest.length) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
    if (total === BigInt(amount)) return tx.object(primary);
    const [inputCoin] = tx.splitCoins(tx.object(primary), [BigInt(amount)]);
    return inputCoin;
  }

  private async executeSevenKSdkQuote(quote: SwapQuote, policy: unknown, dryRun?: boolean) {
    const raw = quote.raw as SevenKSdkQuoteRaw;
    const signer = this.keystore.load();
    const address = signer.toSuiAddress();
    this.setupSevenKSdk(PROVIDERS.find((provider) => provider.id === "7k")!);
    const built = await buildSevenKTx({
      quoteResponse: raw.quote as never,
      accountAddress: address,
      slippage: quote.slippageBps / 10_000,
      commission: { partner: address, commissionBps: 0 },
    });
    if (!isTransactionLike(built.tx)) {
      return {
        policy,
        quote,
        executable: false,
        reason: "7K SDK returned a non-PTB transaction that requires a sponsored/RFQ execution path.",
      };
    }
    const tx = built.tx;
    tx.setSender(address);
    if (built.coinOut) tx.transferObjects([built.coinOut], address);

    const simulation = await this.client.simulateTransaction({
      transaction: await tx.build({ client: this.client }),
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    if (dryRun) return { policy, quote, executable: true, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    this.policy.recordSpend(quote.coinInType === SUI_COIN_TYPE ? quote.amountIn : "0");
    const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { policy, quote, executable: true, digest: executed.digest, result };
  }

  private async executeAftermathSdkQuote(quote: SwapQuote, policy: unknown, dryRun?: boolean) {
    const raw = quote.raw as AftermathSdkQuoteRaw;
    const signer = this.keystore.load();
    const address = signer.toSuiAddress();
    const aftermath = new Aftermath(this.config.network === "testnet" ? "TESTNET" : "MAINNET");
    await aftermath.init();
    const tx = await aftermath.Router().getTransactionForCompleteTradeRoute({
      walletAddress: address,
      completeRoute: raw.route,
      slippage: quote.slippageBps / 10_000,
    });
    tx.setSender(address);

    const simulation = await this.client.simulateTransaction({
      transaction: await tx.build({ client: this.client }),
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    if (dryRun) return { policy, quote, executable: true, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    this.policy.recordSpend(quote.coinInType === SUI_COIN_TYPE ? quote.amountIn : "0");
    const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { policy, quote, executable: true, digest: executed.digest, result };
  }

  private rankQuotes(quotes: SwapQuote[]): RankedSwapQuote[] {
    return [...quotes]
      .sort((a, b) => compareBigInt(scoreQuote(b), scoreQuote(a)))
      .map((quote, index) => ({ ...quote, rank: index + 1, netScore: scoreQuote(quote).toString() }));
  }

  private normalizeAmount(input: QuoteRequest): string {
    if (input.amountIsBaseUnits) return input.amountIn;
    if (input.coinInType === SUI_COIN_TYPE) return parseSuiToMist(input.amountIn);
    throw new Error("Non-SUI swap amounts must be passed in base units for this MVP.");
  }

  private assertWritesAllowed(): void {
    if (this.config.network === "mainnet" && !this.config.allowMainnetWrites) {
      throw new Error("Mainnet writes are disabled. Set SUI_AGENT_ENABLE_MAINNET_WRITES=true to allow them.");
    }
  }

  private setupSevenKSdk(provider: ProviderConfig): void {
    if (this.config.network !== "mainnet") {
      throw new Error("7K SDK supports mainnet only.");
    }
    const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
    if (apiKey) SevenKConfig.setApiKey(apiKey);
    SevenKConfig.setEndpointProvider("Bluefin7k");
    SevenKConfig.setSuiClient(this.client as never);
  }

  private hasSdkAdapter(provider: SwapProviderId): boolean {
    return provider === "aftermath" || provider === "cetus" || (provider === "7k" && this.config.network === "mainnet");
  }
}

function scoreQuote(quote: SwapQuote): bigint {
  return BigInt(quote.expectedAmountOut) - BigInt(quote.estimatedGasMist ?? "0");
}

function isSuiCoinType(coinType: string): boolean {
  return normalizeStructTag(coinType) === normalizeStructTag(SUI_COIN_TYPE) || normalizeStructTag(coinType) === normalizeStructTag(SUI_TYPE_ARG);
}

function compareBigInt(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function extractString(raw: unknown, keys: string[]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return value.toString();
  }
  return undefined;
}

function extractNumber(raw: unknown, keys: string[]): number | undefined {
  const value = extractString(raw, keys);
  return value === undefined ? undefined : Number(value);
}

function extractTransactionBytes(raw: unknown): string | undefined {
  return extractString(raw, ["transactionBytes", "txBytes", "transactionBlock", "transaction"]);
}

function isCetusSdkQuoteRaw(raw: unknown): raw is CetusSdkQuoteRaw {
  return Boolean(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "cetus-sdk");
}

function isAftermathSdkQuoteRaw(raw: unknown): raw is AftermathSdkQuoteRaw {
  return Boolean(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "aftermath-sdk");
}

function isSevenKSdkQuoteRaw(raw: unknown): raw is SevenKSdkQuoteRaw {
  return Boolean(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "7k-sdk");
}

function isTransactionLike(value: unknown): value is Transaction {
  return Boolean(value && typeof value === "object" && typeof (value as { build?: unknown }).build === "function");
}

function summarizeAftermathRoute(route: RouterCompleteTradeRoute): string {
  const protocols = route.routes.flatMap((subroute) => subroute.paths.map((path) => path.protocolName));
  return protocols.length ? protocols.join(" -> ") : "Aftermath Router";
}

function summarizeSevenKRoute(quote: SevenKQuoteResponse): string {
  const routeSources = quote.routes?.flatMap((route) => route.hops?.map((hop) => hop.pool?.type).filter(Boolean) ?? []) ?? [];
  if (routeSources.length) return routeSources.join(" -> ");
  const functions = quote.swaps?.map((swap) => swap.functionName).filter(Boolean) ?? [];
  return functions.length ? functions.join(" -> ") : "7K Aggregator";
}
