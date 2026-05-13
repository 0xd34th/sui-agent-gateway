import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Aftermath, Staking } from "aftermath-ts-sdk";
import { AppConfig } from "./config.js";
import { Keystore } from "./keystore.js";
import { PolicyStore } from "./policy.js";
import { parseSuiToMist, parseUnitsDecimal } from "./sui.js";
import { SUI_COIN_TYPE } from "./types.js";

export type LiquidStakingProviderId = "aftermath" | "springsui" | "haedal" | "volo" | "alphafi";

type LiquidProvider = {
  id: LiquidStakingProviderId;
  name: string;
  receiptAsset: string;
  status: "implemented" | "adapter_needed";
  notes: string;
};

const PROVIDERS: LiquidProvider[] = [
  {
    id: "aftermath",
    name: "Aftermath afSUI",
    receiptAsset: "afSUI",
    status: "implemented",
    notes: "Uses aftermath-ts-sdk to quote, preflight, stake, unstake, and list positions.",
  },
  {
    id: "springsui",
    name: "SpringSui",
    receiptAsset: "sSUI",
    status: "adapter_needed",
    notes: "Next adapter target. Needs verified SDK/PTB builder and receipt coin metadata.",
  },
  {
    id: "haedal",
    name: "Haedal haSUI",
    receiptAsset: "haSUI",
    status: "adapter_needed",
    notes: "Native stake/unstake needs verified SDK/PTB builder. Swap-to-haSUI can be handled through quote_liquid_stake when HAEDAL_HASUI_COIN_TYPE is configured.",
  },
  {
    id: "volo",
    name: "Volo vSUI",
    receiptAsset: "vSUI",
    status: "adapter_needed",
    notes: "Needs verified SDK/PTB builder and unstake queue semantics.",
  },
  {
    id: "alphafi",
    name: "AlphaFi stSUI",
    receiptAsset: "stSUI",
    status: "adapter_needed",
    notes: "Potential SDK exists. Needs dependency review and PTB smoke tests before execution.",
  },
];

export class LiquidStakingService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: SuiGrpcClient,
    private readonly keystore: Keystore,
    private readonly policy: PolicyStore,
  ) {}

  listProviders() {
    return PROVIDERS;
  }

  async quoteStake(input: { amountSui: string; provider?: LiquidStakingProviderId; preflight?: boolean }) {
    const provider = this.provider(input.provider);
    const amountMist = parseSuiToMist(input.amountSui);
    const base = {
      type: "liquid",
      provider: provider.id,
      providerName: provider.name,
      amountMist,
      receiptAsset: provider.receiptAsset,
      lockup: "Liquid staking mints an LST receipt asset. Unstaking behavior depends on provider liquidity and queue rules.",
      policy: this.policy.evaluate({ action: "liquid_stake", amountMist, coinType: SUI_COIN_TYPE }),
    };

    if (provider.id === "haedal") {
      const haSuiCoinType = process.env.HAEDAL_HASUI_COIN_TYPE;
      return {
        ...base,
        executable: false,
        execution: haSuiCoinType ? "swap_route_available" : "coin_type_required",
        receiptCoinType: haSuiCoinType ?? null,
        suggestedTool: haSuiCoinType ? "quote_swap or execute_swap from SUI to HAEDAL_HASUI_COIN_TYPE" : "Set HAEDAL_HASUI_COIN_TYPE to enable secondary-market haSUI routing.",
        notes: provider.notes,
      };
    }

    if (provider.status !== "implemented") {
      return { ...base, executable: false, execution: "adapter_needed", notes: provider.notes };
    }

    const staking = await this.aftermathStaking();
    const [rate, apy, tvl, validator] = await Promise.all([
      staking.getAfSuiToSuiExchangeRate(),
      staking.getApy(),
      staking.getSuiTvl().then((value) => value.toString()),
      this.selectAftermathValidator(staking),
    ]);
    const bounds = {
      minStakeMist: Staking.constants.bounds.minStake.toString(),
      minUnstakeMist: Staking.constants.bounds.minUnstake.toString(),
    };
    const quote = {
      ...base,
      exchangeRate: {
        afSuiToSui: rate,
        expectedReceiptAmount: divideByRate(amountMist, rate),
      },
      apy,
      tvlMist: tvl,
      validator,
      bounds,
      execution: "sdk",
    };

    if (quote.policy.decision === "blocked" || input.preflight === false) return quote;
    if (BigInt(amountMist) < BigInt(bounds.minStakeMist)) {
      return {
        ...quote,
        executable: false,
        preflight: {
          ok: false,
          failure: `amount ${amountMist} MIST is below ${provider.name} stake minimum ${bounds.minStakeMist} MIST`,
          simulation: null,
        },
      };
    }

    const signer = this.keystore.load();
    const tx = await staking.getStakeTransaction({
      walletAddress: signer.toSuiAddress(),
      suiStakeAmount: BigInt(amountMist),
      validatorAddress: validator.address,
    });
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) {
      return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    }
    return { ...quote, executable: true, preflight: { ok: true, failure: undefined, simulation } };
  }

  async quoteUnstake(input: { amount: string; provider?: LiquidStakingProviderId; amountIsBaseUnits?: boolean; atomic?: boolean }) {
    const provider = this.provider(input.provider);
    const amountBaseUnits = input.amountIsBaseUnits === false ? parseUnitsDecimal(input.amount, 9) : input.amount;
    const base = {
      type: "liquid",
      provider: provider.id,
      providerName: provider.name,
      inputAmount: input.amount,
      amountBaseUnits,
      inputAmountIsBaseUnits: input.amountIsBaseUnits !== false,
      receiptAsset: provider.receiptAsset,
      atomic: input.atomic ?? true,
      policy: this.policy.evaluate({ action: "liquid_unstake", coinType: SUI_COIN_TYPE }),
    };
    if (provider.status !== "implemented") {
      return { ...base, executable: false, execution: "adapter_needed", notes: provider.notes };
    }

    const staking = await this.aftermathStaking();
    const [rate, vaultState] = await Promise.all([staking.getAfSuiToSuiExchangeRate(), staking.getStakedSuiVaultState()]);
    const atomicFee = Staking.calcAtomicUnstakeFee({ stakedSuiVaultState: vaultState });
    const bounds = {
      minStakeMist: Staking.constants.bounds.minStake.toString(),
      minUnstakeMist: Staking.constants.bounds.minUnstake.toString(),
    };

    return {
      ...base,
      exchangeRate: {
        afSuiToSui: rate,
        expectedSuiAmountBeforeFee: multiplyByRate(amountBaseUnits, rate),
      },
      fees: {
        atomicUnstakeFeePct: atomicFee,
      },
      bounds,
      execution: "sdk",
      executable: BigInt(amountBaseUnits) >= BigInt(bounds.minUnstakeMist),
    };
  }

  async getPositions(input: { provider?: LiquidStakingProviderId } = {}) {
    const provider = this.provider(input.provider);
    if (provider.status !== "implemented") return { provider: provider.id, executable: false, execution: "adapter_needed", notes: provider.notes, positions: [] };
    const address = this.keystore.getAddress();
    if (!address) throw new Error("No agent wallet exists. Call create_agent_wallet first.");
    const staking = await this.aftermathStaking();
    return {
      provider: provider.id,
      providerName: provider.name,
      positions: await staking.getStakingPositions({ walletAddress: address }),
    };
  }

  async stake(input: { amountSui: string; provider?: LiquidStakingProviderId; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteStake({ ...input, preflight: true });
    if (quote.policy.decision === "blocked" || ("executable" in quote && quote.executable === false)) return quote;
    if (quote.provider !== "aftermath") return quote;

    const signer = this.keystore.load();
    const staking = await this.aftermathStaking();
    const validator = "validator" in quote ? quote.validator : await this.selectAftermathValidator(staking);
    const tx = await staking.getStakeTransaction({
      walletAddress: signer.toSuiAddress(),
      suiStakeAmount: BigInt(quote.amountMist),
      validatorAddress: validator.address,
    });
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    if (input.dryRun) return { ...quote, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, objectTypes: true, balanceChanges: true },
    });
    this.policy.recordSpend(quote.amountMist);
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { ...quote, digest: transaction.digest, result };
  }

  async unstake(input: { amount: string; provider?: LiquidStakingProviderId; lstCoinObjectId?: string; amountIsBaseUnits?: boolean; atomic?: boolean; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteUnstake(input);
    if (quote.policy.decision === "blocked" || !quote.executable) return quote;
    if (quote.provider !== "aftermath") return quote;

    const signer = this.keystore.load();
    const staking = await this.aftermathStaking();
    const tx = await staking.getUnstakeTransaction({
      walletAddress: signer.toSuiAddress(),
      afSuiUnstakeAmount: BigInt(quote.amountBaseUnits),
      isAtomic: quote.atomic,
    });
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) return { ...quote, executable: false, preflight: { ok: false, failure: simulation.error, simulation: null } };
    if (input.dryRun) return { ...quote, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, objectTypes: true, balanceChanges: true },
    });
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { ...quote, digest: transaction.digest, result };
  }

  private provider(providerId: LiquidStakingProviderId = "aftermath") {
    const provider = PROVIDERS.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown liquid staking provider ${providerId}`);
    return provider;
  }

  private async aftermathStaking() {
    if (this.config.network !== "mainnet") throw new Error("Aftermath liquid staking is available on mainnet.");
    const aftermath = new Aftermath("MAINNET");
    await aftermath.init();
    return aftermath.Staking();
  }

  private async selectAftermathValidator(staking: Awaited<ReturnType<LiquidStakingService["aftermathStaking"]>>) {
    const validators = await staking.getActiveValidators();
    const record = [...validators]
      .map((validator) => validator as unknown as Record<string, unknown>)
      .filter((validator) => typeof validator.suiAddress === "string")
      .sort((a, b) => compareBigInt(BigInt((b.votingPower as string | undefined) ?? "0"), BigInt((a.votingPower as string | undefined) ?? "0")))[0];
    if (!record) throw new Error("No active validator found for Aftermath liquid staking");
    return {
      name: typeof record.name === "string" ? record.name : "",
      address: record.suiAddress as string,
      commissionRate: typeof record.commissionRate === "string" ? record.commissionRate : undefined,
      votingPower: typeof record.votingPower === "string" ? record.votingPower : undefined,
    };
  }

  private assertWritesAllowed(): void {
    if (this.config.network === "mainnet" && !this.config.allowMainnetWrites) {
      throw new Error("Mainnet writes are disabled. Set SUI_AGENT_ENABLE_MAINNET_WRITES=true to allow them.");
    }
  }
}

function divideByRate(amount: string, rate: number): string {
  const scaledRate = BigInt(Math.round(rate * 1_000_000_000));
  return ((BigInt(amount) * 1_000_000_000n) / scaledRate).toString();
}

function multiplyByRate(amount: string, rate: number): string {
  const scaledRate = BigInt(Math.round(rate * 1_000_000_000));
  return ((BigInt(amount) * scaledRate) / 1_000_000_000n).toString();
}

function compareBigInt(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
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
