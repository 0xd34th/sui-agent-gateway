import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { BucketClient } from "@bucket-protocol/sdk";
import { AppConfig } from "./config.js";
import { Keystore } from "./keystore.js";
import { PolicyStore } from "./policy.js";
import { parseUnitsDecimal } from "./sui.js";
import { SUI_COIN_TYPE } from "./types.js";

export type CdpProviderId = "bucket" | "kai-finance";

const CDP_PROVIDERS = [
  {
    id: "bucket" as const,
    name: "Bucket Protocol",
    status: "partially_implemented",
    actions: ["list_collateral", "positions", "deposit_collateral", "quote_borrow", "borrow"],
    notes: "Uses @bucket-protocol/sdk for collateral discovery, positions, collateral deposits, and real manage-position borrow transaction construction.",
  },
  {
    id: "kai-finance" as const,
    name: "Kai Finance",
    status: "adapter_needed",
    actions: ["discovery"],
    notes: "Leveraged-yield/CDP-like flows are high risk. Needs protocol SDK/PTB review before any transaction support.",
  },
];

export class CdpService {
  private bucketPromise?: Promise<BucketClient>;

  constructor(
    private readonly config: AppConfig,
    private readonly client: SuiGrpcClient,
    private readonly keystore: Keystore,
    private readonly policy: PolicyStore,
  ) {}

  listProviders() {
    return CDP_PROVIDERS;
  }

  async listBucketCollateralTypes() {
    const bucket = await this.bucket();
    const [coinTypes, vaults, prices] = await Promise.all([
      bucket.getAllCollateralTypes(),
      bucket.getAllVaultObjects(),
      bucket.getAllOraclePrices().catch(() => ({} as Record<string, number>)),
    ]);

    return coinTypes.map((coinType) => ({
      provider: "bucket",
      coinType,
      price: prices[coinType] ?? null,
      vault: vaults[coinType] ?? null,
    }));
  }

  async getBucketPositions() {
    const bucket = await this.bucket();
    return {
      provider: "bucket",
      positions: await bucket.getUserPositions({ address: this.requireAddress() }),
      savings: await bucket.getUserSavings({ address: this.requireAddress() }),
    };
  }

  async quoteBucketDepositCollateral(input: { coinType: string; amount: string; amountIsBaseUnits?: boolean }) {
    const bucket = await this.bucket();
    const collateral = (await this.listBucketCollateralTypes()).find((item) => sameCoinType(item.coinType, input.coinType));
    if (!collateral) throw new Error(`Bucket collateral type not found: ${input.coinType}`);
    const decimals = input.amountIsBaseUnits ? 0 : input.coinType === SUI_COIN_TYPE ? 9 : (await this.client.getCoinMetadata({ coinType: input.coinType }))?.coinMetadata?.decimals;
    if (typeof decimals !== "number") throw new Error(`Could not resolve decimals for ${input.coinType}; pass amountIsBaseUnits=true.`);

    const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, decimals);
    const amountForPolicy = input.coinType === SUI_COIN_TYPE ? amountBaseUnits : "0";
    const policy = this.policy.evaluate({ action: "cdp_deposit_collateral", amountMist: amountForPolicy, coinType: input.coinType, provider: "bucket" });
    return {
      provider: "bucket",
      action: "cdp_deposit_collateral",
      coinType: collateral.coinType,
      amount: input.amount,
      amountBaseUnits,
      amountForPolicyMist: amountForPolicy,
      collateral,
      usdbCoinType: await bucket.getUsdbCoinType(),
      borrowAmount: "0",
      execution: "sdk",
      executable: policy.decision === "allowed",
      policy,
      notes: "Collateral-only deposit.",
    };
  }

  async quoteBucketBorrow(input: { coinType: string; borrowAmount: string; borrowAmountIsBaseUnits?: boolean; depositAmount?: string; depositAmountIsBaseUnits?: boolean }) {
    const collateral = (await this.listBucketCollateralTypes()).find((item) => sameCoinType(item.coinType, input.coinType));
    if (!collateral) throw new Error(`Bucket collateral type not found: ${input.coinType}`);
    const collateralCoinType = collateral.coinType;
    const collateralDecimals = input.depositAmountIsBaseUnits ? 0 : sameCoinType(collateralCoinType, SUI_COIN_TYPE) ? 9 : (await this.client.getCoinMetadata({ coinType: collateralCoinType }))?.coinMetadata?.decimals;
    if (input.depositAmount && typeof collateralDecimals !== "number") throw new Error(`Could not resolve decimals for ${input.coinType}; pass depositAmountIsBaseUnits=true.`);
    const depositAmountBaseUnits = input.depositAmount
      ? input.depositAmountIsBaseUnits
        ? input.depositAmount
        : parseUnitsDecimal(input.depositAmount, collateralDecimals as number)
      : undefined;
    const borrowAmountBaseUnits = input.borrowAmountIsBaseUnits ? input.borrowAmount : parseUnitsDecimal(input.borrowAmount, 6);
    const amountForPolicy = sameCoinType(collateralCoinType, SUI_COIN_TYPE) && depositAmountBaseUnits ? depositAmountBaseUnits : "0";
    const policy = this.policy.evaluate({ action: "cdp_borrow", amountMist: amountForPolicy, coinType: collateralCoinType, provider: "bucket" });
    return {
      provider: "bucket",
      action: "cdp_borrow",
      coinType: collateralCoinType,
      borrowAmount: input.borrowAmount,
      borrowAmountBaseUnits,
      depositAmount: input.depositAmount,
      depositAmountBaseUnits,
      amountForPolicyMist: amountForPolicy,
      executable: policy.decision === "allowed",
      execution: "sdk",
      policy,
      collateral,
      riskControls: {
        collateralRatio: "protocol",
        liquidationBuffer: "protocol",
        oracleFreshness: "sdk_price_update",
        explicitConfirmationRequired: true,
      },
      notes: "Real Bucket manage-position transaction. If depositAmount is omitted, the borrow uses existing collateral position.",
    };
  }

  async bucketBorrowUsdb(input: { coinType: string; borrowAmount: string; borrowAmountIsBaseUnits?: boolean; depositAmount?: string; depositAmountIsBaseUnits?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteBucketBorrow(input);
    if (!quote.executable) return quote;
    const signer = this.keystore.load();
    const tx = new Transaction();
    tx.setSender(signer.toSuiAddress());
    const bucket = await this.bucket();
    const [, usdbCoin] = await bucket.buildManagePositionTransaction(tx, {
      coinType: quote.coinType,
      depositCoinOrAmount: quote.depositAmountBaseUnits ? Number(quote.depositAmountBaseUnits) : undefined,
      borrowAmount: Number(quote.borrowAmountBaseUnits),
    });
    tx.transferObjects([usdbCoin], tx.pure.address(signer.toSuiAddress()));

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

  async bucketDepositCollateral(input: { coinType: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteBucketDepositCollateral(input);
    if (!quote.executable) return quote;

    const signer = this.keystore.load();
    const tx = new Transaction();
    tx.setSender(signer.toSuiAddress());
    const bucket = await this.bucket();
    await bucket.buildManagePositionTransaction(tx, {
      coinType: quote.coinType,
      depositCoinOrAmount: Number(quote.amountBaseUnits),
      borrowAmount: 0,
    });

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

  private async bucket() {
    if (this.config.network !== "mainnet" && this.config.network !== "testnet") throw new Error("Bucket supports mainnet/testnet in this adapter.");
    this.bucketPromise ??= BucketClient.initialize({ suiClient: this.client, network: this.config.network });
    return this.bucketPromise;
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

function sameCoinType(left: string, right: string) {
  return normalizeCoinType(left) === normalizeCoinType(right);
}

function normalizeCoinType(coinType: string) {
  return coinType.replace(/^0x0*2::sui::SUI$/, SUI_COIN_TYPE);
}
