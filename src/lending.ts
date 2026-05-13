import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import BigNumber from "bignumber.js";
import { AppConfig } from "./config.js";
import { Keystore } from "./keystore.js";
import { PolicyStore } from "./policy.js";
import { parseUnitsDecimal } from "./sui.js";
import { SUI_COIN_TYPE } from "./types.js";

export type LendingProviderId = "scallop" | "navi" | "suilend" | "alphalend" | "current";

type LendingProvider = {
  id: LendingProviderId;
  name: string;
  status: "implemented" | "read_only" | "adapter_needed" | "borrow_blocked";
  actions: string[];
  notes: string;
};

const SUILEND_PACKAGE_ID = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const SUILEND_MARKET_TYPE = `${SUILEND_PACKAGE_ID}::suilend::MAIN_POOL`;

const PROVIDERS: LendingProvider[] = [
  {
    id: "scallop",
    name: "Scallop",
    status: "implemented",
    actions: ["list_markets", "quote_supply", "supply", "quote_withdraw", "withdraw", "quote_borrow", "borrow", "positions"],
    notes: "Uses @scallop-io/sui-scallop-sdk v3 with @mysten/sui v2. Borrow uses the real SDK transaction builder when an obligation/key exists.",
  },
  {
    id: "navi",
    name: "NAVI",
    status: "adapter_needed",
    actions: ["list_markets"],
    notes: "@naviprotocol/lending 1.4.3 imports legacy Sui client helpers at runtime in this v2.16 stack. Real transactions need a v2-safe adapter.",
  },
  {
    id: "suilend",
    name: "Suilend",
    status: "implemented",
    actions: ["list_markets", "quote_supply", "supply", "quote_withdraw", "withdraw", "quote_borrow", "borrow", "positions"],
    notes: "Uses @suilend/sdk v3.0.3 with live v2.16 gRPC smoke coverage. Borrow uses the real SDK transaction builder when an obligation owner cap exists.",
  },
  {
    id: "alphalend",
    name: "AlphaLend",
    status: "adapter_needed",
    actions: ["list_markets"],
    notes: "Needs verified SDK/PTB adapter and market allowlist.",
  },
  {
    id: "current",
    name: "Current",
    status: "adapter_needed",
    actions: ["list_markets"],
    notes: "Needs protocol adapter discovery.",
  },
];

type ScallopMarket = {
  provider: "scallop";
  coinName: string;
  symbol: string;
  coinType: string;
  sCoinType?: string;
  coinDecimal: number;
  supplyApr?: number;
  supplyApy?: number;
  rewardApr?: number;
  availableSupplyAmount?: number;
  availableWithdrawAmount?: number;
};

type SuilendMarket = {
  provider: "suilend";
  symbol: string;
  name: string;
  coinType: string;
  cTokenCoinType: string;
  coinDecimal: number;
  depositAprPercent?: string;
  borrowAprPercent?: string;
  availableAmount?: string;
  depositedAmount?: string;
  depositedAmountUsd?: string;
  cTokenExchangeRate: string;
};

type SuilendState = {
  lendingMarket: {
    reserves: Record<string, unknown>[];
  };
  marketType: string;
};

export class LendingService {
  private scallopPromise?: Promise<Awaited<ReturnType<LendingService["createScallopClient"]>>>;
  private suilendPromise?: Promise<Awaited<ReturnType<LendingService["createSuilendClient"]>>>;
  private suilendStatePromise?: Promise<SuilendState>;

  constructor(
    private readonly config: AppConfig,
    private readonly client: SuiGrpcClient,
    private readonly keystore: Keystore,
    private readonly policy: PolicyStore,
  ) {}

  listProviders() {
    return PROVIDERS;
  }

  async listMarkets(input: { provider?: LendingProviderId } = {}) {
    const provider = this.provider(input.provider);
    if (provider.id === "suilend") {
      const state = await this.loadSuilendState();
      return {
        provider: "suilend",
        providerName: provider.name,
        markets: state.lendingMarket.reserves
          .map((reserve: Record<string, unknown>) => toSuilendMarket(reserve, state.marketType))
          .sort((a: SuilendMarket, b: SuilendMarket) => a.symbol.localeCompare(b.symbol)),
      };
    }
    if (provider.id !== "scallop") {
      return { provider: provider.id, providerName: provider.name, executable: false, execution: "adapter_needed", notes: provider.notes, markets: [] };
    }

    const scallop = await this.scallop();
    const lendings = await scallop.query.getLendings(undefined, this.requireAddress(), { indexer: true });
    return {
      provider: "scallop",
      providerName: provider.name,
      markets: Object.values(lendings ?? {})
        .filter((market): market is NonNullable<typeof market> => Boolean(market))
        .map(toMarket)
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
  }

  async getPositions(input: { provider?: LendingProviderId } = {}) {
    const provider = this.provider(input.provider);
    if (provider.id === "suilend") {
      const address = this.requireAddress();
      const [state, caps] = await Promise.all([this.loadSuilendState(), this.suilendObligationOwnerCaps(address)]);
      const cTokenBalances = await Promise.all(
        state.lendingMarket.reserves.map(async (reserve: Record<string, unknown>) => {
          const market = toSuilendMarket(reserve, state.marketType);
          const coins = await this.client.listCoins({ owner: address, coinType: market.cTokenCoinType }).catch(() => ({ objects: [] as Array<{ balance?: string }> }));
          const balanceBaseUnits = coins.objects.reduce((sum, coin) => sum + BigInt(coin.balance ?? "0"), 0n).toString();
          return { market, balanceBaseUnits };
        }),
      );
      return {
        provider: "suilend",
        providerName: provider.name,
        obligationOwnerCaps: caps.map((cap: Record<string, unknown>) => ({ id: objectId(cap), obligationId: fieldString(cap, "obligationId") })),
        cTokenBalances: cTokenBalances.filter((item) => BigInt(item.balanceBaseUnits) > 0n),
      };
    }
    if (provider.id !== "scallop") return { provider: provider.id, executable: false, execution: "adapter_needed", notes: provider.notes, positions: null };
    const scallop = await this.scallop();
    return {
      provider: "scallop",
      providerName: provider.name,
      positions: await scallop.query.getUserPortfolio({ walletAddress: this.requireAddress(), indexer: true }),
    };
  }

  async quoteSupply(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }) {
    const provider = this.provider(input.provider);
    const base = this.baseQuote("lending_supply", provider, input.coin, input.amount, input.amountIsBaseUnits);
    if (provider.id === "suilend") {
      const market = await this.suilendMarket(input.coin);
      const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
      const amountForPolicy = market.coinType === SUI_COIN_TYPE ? amountBaseUnits : "0";
      const policy = this.policy.evaluate({ action: "lending_supply", amountMist: amountForPolicy, coinType: market.coinType, provider: provider.id });
      return {
        ...base,
        provider: "suilend",
        market,
        amountBaseUnits,
        amountForPolicyMist: amountForPolicy,
        expectedReceiptAsset: market.cTokenCoinType,
        execution: "sdk",
        executable: policy.decision === "allowed",
        policy,
      };
    }
    if (provider.id !== "scallop") return { ...base, executable: false, execution: "adapter_needed", notes: provider.notes };

    const market = await this.scallopMarket(input.coin);
    const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
    const amountForPolicy = market.coinType === SUI_COIN_TYPE ? amountBaseUnits : "0";
    const policy = this.policy.evaluate({ action: "lending_supply", amountMist: amountForPolicy, coinType: market.coinType, provider: provider.id });
    return {
      ...base,
      provider: "scallop",
      market,
      amountBaseUnits,
      amountForPolicyMist: amountForPolicy,
      expectedReceiptAsset: market.sCoinType ?? `Scallop sCoin for ${market.symbol}`,
      execution: "sdk",
      executable: policy.decision === "allowed",
      policy,
    };
  }

  async quoteWithdraw(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }) {
    const provider = this.provider(input.provider);
    const base = this.baseQuote("lending_withdraw", provider, input.coin, input.amount, input.amountIsBaseUnits);
    if (provider.id === "suilend") {
      const market = await this.suilendMarket(input.coin);
      const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
      const cTokenAmountBaseUnits = new BigNumber(amountBaseUnits).div(market.cTokenExchangeRate).integerValue(BigNumber.ROUND_CEIL).toFixed(0);
      const policy = this.policy.evaluate({ action: "lending_withdraw", coinType: market.coinType, provider: provider.id });
      return {
        ...base,
        provider: "suilend",
        market,
        amountBaseUnits,
        cTokenAmountBaseUnits,
        burnsReceiptAsset: market.cTokenCoinType,
        expectedOutputAsset: market.coinType,
        execution: "sdk",
        executable: policy.decision === "allowed",
        policy,
      };
    }
    if (provider.id !== "scallop") return { ...base, executable: false, execution: "adapter_needed", notes: provider.notes };

    const market = await this.scallopMarket(input.coin);
    const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
    const policy = this.policy.evaluate({ action: "lending_withdraw", coinType: market.coinType, provider: provider.id });
    return {
      ...base,
      provider: "scallop",
      market,
      amountBaseUnits,
      burnsReceiptAsset: market.sCoinType ?? `Scallop sCoin for ${market.symbol}`,
      expectedOutputAsset: market.coinType,
      execution: "sdk",
      executable: policy.decision === "allowed",
      policy,
    };
  }

  async quoteBorrow(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }) {
    const provider = this.provider(input.provider);
    const policy = this.policy.evaluate({ action: "lending_borrow", provider: provider.id });
    if (provider.id === "suilend") {
      const market = await this.suilendMarket(input.coin);
      const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
      const obligation = await this.firstSuilendObligation(this.requireAddress());
      return this.borrowQuote(provider, input.coin, input.amount, amountBaseUnits, policy, {
        market,
        borrowAprPercent: market.borrowAprPercent,
        outputAsset: market.coinType,
        obligation,
        execution: obligation ? "sdk" : "needs_obligation",
        executable: policy.decision === "allowed" && Boolean(obligation),
        notes: obligation
          ? "Real Suilend borrow transaction can be built against the existing obligation owner cap."
          : "No Suilend obligation owner cap found. Deposit collateral into a Suilend obligation before borrowing.",
      });
    }
    if (provider.id === "scallop") {
      const market = await this.scallopMarket(input.coin);
      const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, market.coinDecimal);
      const obligation = await this.firstScallopObligation();
      return this.borrowQuote(provider, input.coin, input.amount, amountBaseUnits, policy, {
        market,
        outputAsset: market.coinType,
        obligation,
        execution: obligation ? "sdk" : "needs_obligation",
        executable: policy.decision === "allowed" && Boolean(obligation),
        notes: obligation
          ? "Real Scallop borrow transaction can be built against the existing obligation/key."
          : "No Scallop obligation/key found. Deposit collateral into a Scallop obligation before borrowing.",
      });
    }
    return {
      provider: provider.id,
      providerName: provider.name,
      action: "lending_borrow",
      coin: input.coin,
      amount: input.amount,
      amountBaseUnits: input.amount,
      executable: false,
      execution: "adapter_needed",
      policy,
      notes: "This provider still needs a real v2 transaction adapter before borrowing onchain.",
    };
  }

  async borrow(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteBorrow(input);
    if (!quote.executable) return quote;
    if (!("market" in quote)) return quote;

    const signer = this.keystore.load();
    const market = quote.market as ScallopMarket | SuilendMarket;
    if (quote.provider === "suilend" && market.provider === "suilend") {
      const obligation = "obligation" in quote ? (quote.obligation as { capId: string; obligationId: string } | undefined) : undefined;
      if (!obligation) return quote;
      const tx = new Transaction();
      tx.setSender(signer.toSuiAddress());
      const suilend = await this.suilend();
      await suilend.borrowAndSendToUser(signer.toSuiAddress(), tx.object(obligation.capId), obligation.obligationId, market.coinType, quote.amountBaseUnits, tx);
      return this.simulateOrExecuteBorrow(tx, quote, input.dryRun);
    }

    if (quote.provider === "scallop" && market.provider === "scallop") {
      const obligation = "obligation" in quote ? (quote.obligation as { obligationId: string; obligationKey: string } | undefined) : undefined;
      if (!obligation) return quote;
      const scallop = await this.scallop();
      const tx = await scallop.borrow(market.coinName, Number(quote.amountBaseUnits), false, obligation.obligationId, obligation.obligationKey, signer.toSuiAddress()) as Transaction;
      return this.simulateOrExecuteBorrow(tx, quote, input.dryRun);
    }

    return quote;
  }

  async supply(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteSupply(input);
    if (!quote.executable) return quote;
    if (!("market" in quote)) return quote;
    if (quote.provider === "suilend" && quote.market.provider === "suilend") {
      const signer = this.keystore.load();
      const suilend = await this.suilend();
      const tx = new Transaction();
      tx.setSender(signer.toSuiAddress());
      await suilend.depositLiquidityAndGetCTokens(signer.toSuiAddress(), quote.market.coinType, quote.amountBaseUnits, tx);
      const simulation = await simulateSafely(this.client, tx);
      if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
      if (input.dryRun) return { ...quote, preflight: { ok: true, simulation } };

      const result = await this.client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        include: { effects: true, balanceChanges: true, objectTypes: true },
      });
      if (BigInt(quote.amountForPolicyMist) > 0n) this.policy.recordSpend(quote.amountForPolicyMist);
      const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      return { ...quote, digest: transaction.digest, result };
    }
    if (quote.market.provider !== "scallop") return quote;
    const signer = this.keystore.load();
    const scallop = await this.scallop();
    const tx = await scallop.supply(quote.market.coinName, Number(quote.amountBaseUnits), false, signer.toSuiAddress()) as Transaction;
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    if (input.dryRun) return { ...quote, preflight: { ok: true, simulation } };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    if (BigInt(quote.amountForPolicyMist) > 0n) this.policy.recordSpend(quote.amountForPolicyMist);
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { ...quote, digest: transaction.digest, result };
  }

  async withdraw(input: { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteWithdraw(input);
    if (!quote.executable) return quote;
    if (!("market" in quote)) return quote;
    if (quote.provider === "suilend" && quote.market.provider === "suilend") {
      const signer = this.keystore.load();
      const suilend = await this.suilend();
      const tx = new Transaction();
      tx.setSender(signer.toSuiAddress());
      if (!("cTokenAmountBaseUnits" in quote)) return quote;
      const cToken = await this.buildSuilendCTokenInput(tx, signer.toSuiAddress(), quote.market.cTokenCoinType, quote.cTokenAmountBaseUnits);
      const [exemption] = tx.moveCall({
        target: "0x1::option::none",
        typeArguments: [`${SUILEND_PACKAGE_ID}::lending_market::RateLimiterExemption<${SUILEND_MARKET_TYPE}, ${quote.market.coinType}>`],
        arguments: [],
      });
      const [withdrawCoin] = suilend.redeem(cToken, quote.market.coinType, exemption, tx);
      tx.transferObjects([withdrawCoin], tx.pure.address(signer.toSuiAddress()));
      const simulation = await simulateSafely(this.client, tx);
      if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
      if (input.dryRun) return { ...quote, preflight: { ok: true, simulation } };

      const result = await this.client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        include: { effects: true, balanceChanges: true, objectTypes: true },
      });
      const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      return { ...quote, digest: transaction.digest, result };
    }
    if (quote.market.provider !== "scallop") return quote;
    const signer = this.keystore.load();
    const scallop = await this.scallop();
    const tx = await scallop.withdraw(quote.market.coinName, Number(quote.amountBaseUnits), false, signer.toSuiAddress()) as Transaction;
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    if (input.dryRun) return { ...quote, preflight: { ok: true, simulation } };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { ...quote, digest: transaction.digest, result };
  }

  private baseQuote(action: "lending_supply" | "lending_withdraw", provider: LendingProvider, coin: string, amount: string, amountIsBaseUnits?: boolean) {
    return {
      provider: provider.id,
      providerName: provider.name,
      action,
      coin,
      amount,
      inputAmountIsBaseUnits: amountIsBaseUnits === true,
    };
  }

  private borrowQuote(provider: LendingProvider, coin: string, amount: string, amountBaseUnits: string, policy: ReturnType<PolicyStore["evaluate"]>, details: Record<string, unknown>) {
    return {
      provider: provider.id,
      providerName: provider.name,
      action: "lending_borrow",
      coin,
      amount,
      amountBaseUnits,
      executable: policy.decision === "allowed",
      execution: "sdk",
      policy,
      riskControls: {
        maxLtv: "protocol",
        liquidationBuffer: "protocol",
        oracleFreshness: "sdk_refresh",
        explicitConfirmationRequired: true,
      },
      ...details,
    };
  }

  private async simulateOrExecuteBorrow(tx: Transaction, quote: Record<string, unknown>, dryRun?: boolean) {
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    if (dryRun) return { ...quote, preflight: { ok: true, simulation } };

    const signer = this.keystore.load();
    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { ...quote, digest: transaction.digest, result };
  }

  private async firstSuilendObligation(address: string) {
    const caps = await this.suilendObligationOwnerCaps(address);
    const cap = caps[0];
    if (!cap) return undefined;
    const capId = objectId(cap);
    const obligationId = fieldString(cap, "obligationId");
    if (!capId || !obligationId) return undefined;
    return { capId, obligationId };
  }

  private async firstScallopObligation() {
    const scallop = await this.scallop();
    const obligations = await scallop.query.getObligations(this.requireAddress());
    const obligation = obligations[0] as { id?: string; keyId?: string } | undefined;
    if (!obligation?.id || !obligation.keyId) return undefined;
    return { obligationId: obligation.id, obligationKey: obligation.keyId };
  }

  private async scallopMarket(coin: string): Promise<ScallopMarket> {
    const markets = await this.listMarkets({ provider: "scallop" });
    const normalized = coin.toLowerCase();
    const market = markets.markets.find(
      (item): item is ScallopMarket =>
        item.provider === "scallop" &&
        (item.coinName.toLowerCase() === normalized || item.symbol.toLowerCase() === normalized || item.coinType.toLowerCase() === normalized),
    );
    if (!market) throw new Error(`Scallop market not found for ${coin}`);
    return market;
  }

  private async suilendMarket(coin: string): Promise<SuilendMarket> {
    const state = await this.loadSuilendState();
    const markets = state.lendingMarket.reserves.map((reserve) => toSuilendMarket(reserve, state.marketType));
    const normalized = coin.toLowerCase();
    const market = markets.find(
      (item) => item.symbol.toLowerCase() === normalized || item.name.toLowerCase() === normalized || item.coinType.toLowerCase() === normalized,
    );
    if (!market) throw new Error(`Suilend market not found for ${coin}`);
    return market;
  }

  private provider(providerId: LendingProviderId = "scallop") {
    const provider = PROVIDERS.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown lending provider ${providerId}`);
    return provider;
  }

  private async scallop() {
    this.scallopPromise ??= this.createScallopClient();
    return this.scallopPromise;
  }

  private async suilend() {
    this.suilendPromise ??= this.createSuilendClient();
    return this.suilendPromise;
  }

  private async loadSuilendState(): Promise<SuilendState> {
    this.suilendStatePromise ??= (async () => {
      const sdk = await this.loadSuilendSdk();
      const suilend = await this.suilend();
      return {
        ...(await sdk.initializeSuilend(this.client, suilend)),
        marketType: sdk.LENDING_MARKET_TYPE as string,
      };
    })();
    return this.suilendStatePromise;
  }

  private async createSuilendClient() {
    if (this.config.network !== "mainnet") throw new Error("Suilend SDK adapter is currently configured for mainnet only.");
    const sdk = await this.loadSuilendSdk();
    return sdk.SuilendClient.initialize(sdk.LENDING_MARKET_ID, sdk.LENDING_MARKET_TYPE, this.client);
  }

  private async suilendObligationOwnerCaps(address: string) {
    const sdk = await this.loadSuilendSdk();
    return sdk.SuilendClient.getObligationOwnerCaps(address, [sdk.LENDING_MARKET_TYPE], this.client);
  }

  private async loadSuilendSdk() {
    const [clientModule, initializeModule] = await Promise.all([import("@suilend/sdk/client"), import("@suilend/sdk/lib/initialize")]);
    const clientSdk = (clientModule as unknown as { default: Record<string, unknown> }).default ?? clientModule;
    const initializeSdk = (initializeModule as unknown as { default: Record<string, unknown> }).default ?? initializeModule;
    return {
      SuilendClient: clientSdk.SuilendClient as {
        initialize: (marketId: string, marketType: string, client: SuiGrpcClient) => Promise<{
          depositLiquidityAndGetCTokens: (owner: string, coinType: string, value: string, tx: Transaction) => Promise<void>;
          borrowAndSendToUser: (owner: string, obligationOwnerCap: TransactionObjectArgument, obligationId: string, coinType: string, value: string, tx: Transaction) => Promise<void>;
          redeem: (ctokens: TransactionObjectArgument, coinType: string, exemption: TransactionObjectArgument, tx: Transaction) => TransactionObjectArgument[];
        }>;
        getObligationOwnerCaps: (owner: string, marketTypes: string[], client: SuiGrpcClient) => Promise<Record<string, unknown>[]>;
      },
      LENDING_MARKET_ID: clientSdk.LENDING_MARKET_ID as string,
      LENDING_MARKET_TYPE: clientSdk.LENDING_MARKET_TYPE as string,
      initializeSuilend: initializeSdk.initializeSuilend as (client: SuiGrpcClient, suilend: unknown) => Promise<{ lendingMarket: { reserves: Record<string, unknown>[] } }>,
    };
  }

  private async buildSuilendCTokenInput(tx: Transaction, owner: string, cTokenCoinType: string, amount: string) {
    let cursor: string | undefined;
    let coins: Array<{ objectId: string; balance: string }> = [];
    do {
      const page = await this.client.listCoins({ owner, coinType: cTokenCoinType, cursor });
      coins = coins.concat(page.objects.map((coin) => ({ objectId: coin.objectId, balance: coin.balance })));
      cursor = page.hasNextPage ? (page.cursor ?? undefined) : undefined;
    } while (cursor);

    const total = coins.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
    if (total < BigInt(amount)) throw new Error(`Insufficient Suilend cToken balance for ${cTokenCoinType}`);
    const [first, ...rest] = coins;
    if (!first) throw new Error(`No Suilend cTokens found for ${cTokenCoinType}`);
    if (rest.length) tx.mergeCoins(tx.object(first.objectId), rest.map((coin) => tx.object(coin.objectId)));
    if (total === BigInt(amount)) return tx.object(first.objectId);
    const [split] = tx.splitCoins(tx.object(first.objectId), [amount]);
    return split;
  }

  private async createScallopClient() {
    if (this.config.network !== "mainnet") throw new Error("Scallop SDK adapter is currently configured for mainnet only.");
    const signer = this.keystore.load();
    const sdk = new Scallop({
      networkType: "mainnet",
      secretKey: signer.getSecretKey(),
      walletAddress: signer.toSuiAddress(),
      fullnodeUrls: [this.config.rpcUrl],
    });
    return sdk.createScallopClient();
  }

  private requireAddress(): string {
    const address = this.keystore.getAddress();
    if (!address) throw new Error("No agent wallet exists. Call create_agent_wallet first.");
    return address;
  }

  private assertWritesAllowed(): void {
    if (this.config.network === "mainnet" && !this.config.allowMainnetWrites) {
      throw new Error("Mainnet writes are disabled. Set SUI_AGENT_ENABLE_MAINNET_WRITES=true to allow them.");
    }
  }
}

function toMarket(market: Record<string, unknown>): ScallopMarket {
  return {
    provider: "scallop",
    coinName: String(market.coinName),
    symbol: String(market.symbol),
    coinType: String(market.coinType),
    sCoinType: typeof market.sCoinType === "string" ? market.sCoinType : undefined,
    coinDecimal: Number(market.coinDecimal),
    supplyApr: numberOrUndefined(market.supplyApr),
    supplyApy: numberOrUndefined(market.supplyApy),
    rewardApr: numberOrUndefined(market.rewardApr),
    availableSupplyAmount: numberOrUndefined(market.availableSupplyAmount),
    availableWithdrawAmount: numberOrUndefined(market.availableWithdrawAmount),
  };
}

function toSuilendMarket(market: Record<string, unknown>, marketType: string): SuilendMarket {
  const token = record(market.token);
  const coinType = String(market.coinType);
  return {
    provider: "suilend",
    symbol: String(market.symbol ?? token.symbol ?? ""),
    name: String(market.name ?? token.name ?? ""),
    coinType,
    cTokenCoinType: `${SUILEND_PACKAGE_ID}::reserve::CToken<${marketType}, ${coinType}>`,
    coinDecimal: Number(market.mintDecimals ?? token.decimals),
    depositAprPercent: decimalString(market.depositAprPercent),
    borrowAprPercent: decimalString(market.borrowAprPercent),
    availableAmount: decimalString(market.availableAmount),
    depositedAmount: decimalString(market.depositedAmount),
    depositedAmountUsd: decimalString(market.depositedAmountUsd),
    cTokenExchangeRate: decimalString(market.cTokenExchangeRate) ?? "1",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function fieldString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && "id" in field && typeof (field as { id?: unknown }).id === "string") return (field as { id: string }).id;
  return undefined;
}

function objectId(value: Record<string, unknown>): string | undefined {
  const id = value.id;
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "id" in id && typeof (id as { id?: unknown }).id === "string") return (id as { id: string }).id;
  return undefined;
}

function decimalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value.toString() : undefined;
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object" && "toString" in value && typeof (value as { toString?: unknown }).toString === "function") {
    return (value as { toString: () => string }).toString();
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function simulateSafely(client: SuiGrpcClient, tx: Transaction) {
  try {
    return await client.simulateTransaction({
      transaction: await tx.build({ client }),
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
