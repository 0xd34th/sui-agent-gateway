import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Aftermath, Staking } from "aftermath-ts-sdk";
import {
  isValidSuiAddress,
  isValidSuiNSName,
  MIST_PER_SUI,
  normalizeSuiAddress,
  normalizeSuiNSName,
  SUI_SYSTEM_STATE_OBJECT_ID,
  SUI_TYPE_ARG,
} from "@mysten/sui/utils";
import { AppConfig } from "./config.js";
import { Keystore } from "./keystore.js";
import { PolicyStore } from "./policy.js";
import { SUI_COIN_TYPE } from "./types.js";

export function createSuiClient(config: AppConfig): SuiGrpcClient {
  return new SuiGrpcClient({ network: config.network, baseUrl: config.rpcUrl });
}

export function parseUnitsDecimal(value: string, decimals: number): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid decimal amount "${value}"`);
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimals`);
  return `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

export function parseSuiToMist(amountSui: string): string {
  return parseUnitsDecimal(amountSui, 9);
}

export async function resolveRecipient(client: SuiGrpcClient, recipient: string): Promise<{ input: string; address: string; suinsName?: string }> {
  if (isValidSuiAddress(recipient)) {
    return { input: recipient, address: normalizeSuiAddress(recipient) };
  }

  const normalizedName = normalizeSuiNSName(recipient, "dot");
  if (!isValidSuiNSName(normalizedName)) {
    throw new Error(`Recipient is neither a valid Sui address nor a valid SuiNS name: ${recipient}`);
  }

  const response = await client.nameService.lookupName({ name: normalizedName }).response;
  const address = response.record?.targetAddress;
  if (!address) throw new Error(`No SuiNS address found for ${normalizedName}`);
  return { input: recipient, address: normalizeSuiAddress(address), suinsName: normalizedName };
}

export class SuiWalletService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: SuiGrpcClient,
    private readonly keystore: Keystore,
    private readonly policy: PolicyStore,
  ) {}

  async getBalances() {
    const address = this.requireAddress();
    const page = await this.client.listBalances({ owner: address });
    return page.balances;
  }

  async getPortfolio() {
    const balances = await this.getBalances();
    const enriched = await Promise.all(
      balances.map(async (balance) => {
        const metadata = await this.client.getCoinMetadata({ coinType: balance.coinType }).then((result) => result.coinMetadata).catch(() => null);
        return { ...balance, metadata };
      }),
    );
    return { address: this.requireAddress(), balances: enriched };
  }

  receive() {
    const address = this.requireAddress();
    return {
      address,
      uri: `sui:${address}`,
      note: "Fund this capped sub-wallet only with assets the agent may use under policy.",
    };
  }

  async send(input: { recipient: string; coinType?: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }) {
    this.assertWritesAllowed();
    const coinType = input.coinType ?? SUI_COIN_TYPE;
    const decimals =
      input.amountIsBaseUnits ? 0 : coinType === SUI_COIN_TYPE ? 9 : (await this.client.getCoinMetadata({ coinType }))?.coinMetadata?.decimals;
    if (typeof decimals !== "number") throw new Error(`Could not resolve decimals for ${coinType}; pass amountIsBaseUnits=true.`);

    const amountBaseUnits = input.amountIsBaseUnits ? input.amount : parseUnitsDecimal(input.amount, decimals);
    const mistImpact = coinType === SUI_COIN_TYPE ? amountBaseUnits : "0";
    const decision = this.policy.evaluate({ action: "send", amountMist: mistImpact, coinType });
    if (decision.decision === "blocked") return { policy: decision };

    const signer = this.keystore.load();
    const resolved = await resolveRecipient(this.client, input.recipient);
    const tx = await this.buildSendTransaction({
      sender: signer.toSuiAddress(),
      recipient: resolved.address,
      coinType,
      amountBaseUnits,
    });

    const simulation = await this.client.simulateTransaction({
      transaction: await tx.build({ client: this.client }),
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    if (input.dryRun) return { policy: decision, resolvedRecipient: resolved, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, balanceChanges: true, objectTypes: true },
    });
    this.policy.recordSpend(mistImpact);
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { policy: decision, resolvedRecipient: resolved, digest: transaction.digest, result };
  }

  async buildSendTransaction(input: { sender: string; recipient: string; coinType: string; amountBaseUnits: string }): Promise<Transaction> {
    const tx = new Transaction();
    tx.setSender(input.sender);

    if (input.coinType === SUI_COIN_TYPE || input.coinType === SUI_TYPE_ARG) {
      const [coin] = tx.splitCoins(tx.gas, [BigInt(input.amountBaseUnits)]);
      tx.transferObjects([coin], input.recipient);
      return tx;
    }

    const coins = await this.client.listCoins({ owner: input.sender, coinType: input.coinType });
    let total = 0n;
    const selected: string[] = [];
    for (const coin of coins.objects) {
      selected.push(coin.objectId);
      total += BigInt(coin.balance);
      if (total >= BigInt(input.amountBaseUnits)) break;
    }
    if (total < BigInt(input.amountBaseUnits)) throw new Error(`Insufficient ${input.coinType} balance`);
    const [primary, ...rest] = selected;
    if (rest.length) tx.mergeCoins(tx.object(primary), rest.map((id) => tx.object(id)));
    const [payment] = tx.splitCoins(tx.object(primary), [BigInt(input.amountBaseUnits)]);
    tx.transferObjects([payment], input.recipient);
    return tx;
  }

  async listValidators(limit = 50) {
    const system = await this.client.core.getCurrentSystemState();
    const activeValidators = ((system.systemState as unknown as { validatorSet?: { activeValidators?: unknown[] } }).validatorSet?.activeValidators ?? []) as Record<string, unknown>[];
    const validators = activeValidators.map((validator) => ({
      name: typeof validator.name === "string" ? validator.name : "",
      address: validatorAddress(validator),
      stakingPoolId: (validator.stakingPool as { id?: string } | undefined)?.id,
      commissionRate: typeof validator.commissionRate === "string" ? validator.commissionRate : undefined,
      votingPower: typeof validator.votingPower === "string" ? validator.votingPower : undefined,
      source: "sui-grpc",
    }));
    if (validators.length) return validators.slice(0, limit);

    const aftermath = new Aftermath(this.config.network === "testnet" ? "TESTNET" : "MAINNET");
    await aftermath.init();
    const sdkValidators = await aftermath.Staking().getActiveValidators();
    return sdkValidators.slice(0, limit).map((validator) => {
      const record = validator as unknown as Record<string, unknown>;
      return {
        name: typeof record.name === "string" ? record.name : "",
        address: validatorAddress(record),
        stakingPoolId: typeof record.stakingPoolId === "string" ? record.stakingPoolId : undefined,
        commissionRate: typeof record.commissionRate === "string" ? record.commissionRate : undefined,
        votingPower: typeof record.votingPower === "string" ? record.votingPower : undefined,
        source: "aftermath-sdk",
      };
    });
  }

  async getNativeStakes() {
    return this.client.listOwnedObjects({
      owner: this.requireAddress(),
      type: "0x3::staking_pool::StakedSui",
      include: { json: true, display: true },
    });
  }

  async quoteNativeStake(input: { amountSui: string; validatorAddress?: string; preflight?: boolean }) {
    const amountMist = parseSuiToMist(input.amountSui);
    const validator = input.validatorAddress ? await this.findValidator(input.validatorAddress) : await this.selectDefaultValidator();
    const policy = this.policy.evaluate({ action: "native_stake", amountMist, coinType: SUI_COIN_TYPE });
    const bounds = this.nativeStakeBounds();
    const quote = {
      type: "native",
      amountMist,
      validator,
      bounds,
      lockup: "Stake activates at the next epoch. Native unstake returns SUI after network-defined stake withdrawal rules.",
      receiptAsset: "StakedSui object",
      policy,
    };
    if (policy.decision === "blocked" || input.preflight === false) return quote;
    if (BigInt(amountMist) < BigInt(bounds.minStakeMist)) {
      return {
        ...quote,
        executable: false,
        preflight: {
          ok: false,
          failure: `amount ${amountMist} MIST is below native stake minimum ${bounds.minStakeMist} MIST`,
          simulation: null,
        },
      };
    }

    const signer = this.keystore.load();
    const tx = this.buildNativeStakeTransaction({
      sender: signer.toSuiAddress(),
      validatorAddress: validator.address,
      amountMist,
    });
    const simulation = await simulateSafely(this.client, tx);
    if ("error" in simulation) {
      return {
        ...quote,
        executable: false,
        preflight: {
          ok: false,
          failure: simulation.error,
          simulation: null,
        },
      };
    }
    const failure = simulationFailureReason(simulation);
    return {
      ...quote,
      executable: !failure,
      preflight: {
        ok: !failure,
        failure,
        simulation,
      },
    };
  }

  async nativeStake(input: { amountSui: string; validatorAddress?: string; dryRun?: boolean }) {
    if (!input.dryRun) this.assertWritesAllowed();
    const quote = await this.quoteNativeStake(input);
    if (quote.policy.decision === "blocked") return quote;
    if ("preflight" in quote && quote.preflight && !quote.preflight.ok) return quote;

    const signer = this.keystore.load();
    const tx = this.buildNativeStakeTransaction({
      sender: signer.toSuiAddress(),
      validatorAddress: quote.validator.address,
      amountMist: quote.amountMist,
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

  buildNativeStakeTransaction(input: { sender: string; validatorAddress: string; amountMist: string }): Transaction {
    const tx = new Transaction();
    tx.setSender(input.sender);
    const [stakeCoin] = tx.splitCoins(tx.gas, [BigInt(input.amountMist)]);
    tx.moveCall({
      target: "0x3::sui_system::request_add_stake",
      arguments: [tx.object(SUI_SYSTEM_STATE_OBJECT_ID), stakeCoin, tx.pure.address(input.validatorAddress)],
    });
    return tx;
  }

  async nativeUnstake(input: { stakedSuiObjectId: string; dryRun?: boolean }) {
    this.assertWritesAllowed();
    const policy = this.policy.evaluate({ action: "native_unstake", coinType: SUI_COIN_TYPE });
    if (policy.decision === "blocked") return { policy };

    const signer = this.keystore.load();
    const tx = new Transaction();
    tx.setSender(signer.toSuiAddress());
    tx.moveCall({
      target: "0x3::sui_system::request_withdraw_stake",
      arguments: [tx.object(SUI_SYSTEM_STATE_OBJECT_ID), tx.object(input.stakedSuiObjectId)],
    });

    const simulation = await this.client.simulateTransaction({ transaction: await tx.build({ client: this.client }), include: { effects: true, balanceChanges: true, objectTypes: true } });
    if (input.dryRun) return { policy, simulation };

    const result = await this.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      include: { effects: true, objectTypes: true, balanceChanges: true },
    });
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    return { policy, digest: transaction.digest, result };
  }

  private async findValidator(address: string) {
    const normalized = normalizeSuiAddress(address);
    const validators = await this.listValidators(10_000);
    const validator = validators.find((item) => typeof item.address === "string" && normalizeSuiAddress(item.address) === normalized);
    if (!validator) throw new Error(`Validator ${address} is not active`);
    return validator;
  }

  private async selectDefaultValidator() {
    const validators = await this.listValidators(10_000);
    const [validator] = validators
      .filter((item) => item.address)
      .sort((a, b) => compareBigInt(BigInt(b.votingPower ?? "0"), BigInt(a.votingPower ?? "0")));
    if (!validator) throw new Error("No active validator found");
    return validator;
  }

  private nativeStakeBounds() {
    return {
      minStakeMist: Staking.constants.bounds.minStake.toString(),
      source: "aftermath-sdk",
    };
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

export const MIST_PER_SUI_STRING = MIST_PER_SUI.toString();

function validatorAddress(validator: Record<string, unknown>): string {
  const direct = validator.address ?? validator.suiAddress;
  return typeof direct === "string" ? direct : "";
}

function compareBigInt(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function simulationFailureReason(simulation: unknown): string | undefined {
  const root = unwrapTransactionEnvelope(simulation);
  const status = findStatus(root);
  if (!status) return undefined;
  if (typeof status === "string") return status.toLowerCase() === "success" ? undefined : status;
  if (typeof status !== "object") return undefined;
  const record = status as Record<string, unknown>;
  if (record.$kind === "Success" || record.status === "success") return undefined;
  if (record.$kind === "Failure") return stringifyFailure(record.Failure ?? record.error ?? record);
  if (record.status === "failure" || record.status === "Failure") return stringifyFailure(record.error ?? record);
  return undefined;
}

function unwrapTransactionEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.$kind === "Transaction") return record.Transaction;
  if (record.$kind === "FailedTransaction") return record.FailedTransaction;
  return value;
}

function findStatus(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const effects = record.effects;
  if (effects && typeof effects === "object" && "status" in effects) {
    return (effects as Record<string, unknown>).status;
  }
  if ("status" in record) return record.status;
  return undefined;
}

function stringifyFailure(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "error" in value && typeof (value as { error?: unknown }).error === "string") {
    return (value as { error: string }).error;
  }
  return JSON.stringify(value);
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
