import { AppConfig } from "./config.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import { AgentPolicy, PolicyResult, SpendLedger, WriteAction } from "./types.js";

export const defaultPolicy: AgentPolicy = {
  paused: false,
  dailySpendLimitMist: "5000000000",
  perActionSpendLimitMist: "1000000000",
  maxSlippageBps: 100,
  allowedCoinTypes: ["*"],
  allowedSwapProviders: ["7k", "aftermath", "cetus"],
  allowedLendingProviders: ["scallop", "suilend"],
  allowedActions: [
    "send",
    "swap",
    "native_stake",
    "native_unstake",
    "liquid_stake",
    "liquid_unstake",
    "lending_supply",
    "lending_withdraw",
    "lending_borrow",
    "cdp_deposit_collateral",
    "cdp_withdraw_collateral",
    "cdp_borrow",
  ],
};

export class PolicyStore {
  constructor(private readonly config: AppConfig) {}

  get(): AgentPolicy {
    return { ...defaultPolicy, ...readJsonFile(this.config.policyPath, defaultPolicy) };
  }

  update(patch: Partial<AgentPolicy>): AgentPolicy {
    const next = { ...this.get(), ...patch };
    writeJsonFile(this.config.policyPath, next);
    return next;
  }

  setPaused(paused: boolean): AgentPolicy {
    return this.update({ paused });
  }

  getLedger(): SpendLedger {
    const today = new Date().toISOString().slice(0, 10);
    const ledger = readJsonFile<SpendLedger>(this.config.ledgerPath, { day: today, spentMist: "0" });
    if (ledger.day !== today) {
      return { day: today, spentMist: "0" };
    }
    return ledger;
  }

  recordSpend(amountMist: string): SpendLedger {
    const ledger = this.getLedger();
    const next = {
      day: ledger.day,
      spentMist: (BigInt(ledger.spentMist) + BigInt(amountMist)).toString(),
    };
    writeJsonFile(this.config.ledgerPath, next);
    return next;
  }

  evaluate(input: {
    action: WriteAction;
    amountMist?: string;
    coinType?: string;
    provider?: string;
    slippageBps?: number;
  }): PolicyResult {
    const policy = this.get();
    const reasons: string[] = [];

    if (policy.paused) reasons.push("wallet is paused");
    if (!policy.allowedActions.includes(input.action)) reasons.push(`action ${input.action} is disabled`);
    if (input.coinType && !policy.allowedCoinTypes.includes("*") && !policy.allowedCoinTypes.includes(input.coinType)) {
      reasons.push(`coin type ${input.coinType} is not allowed`);
    }
    if (input.provider && input.action === "swap" && !policy.allowedSwapProviders.includes(input.provider)) {
      reasons.push(`swap provider ${input.provider} is not allowed`);
    }
    if (input.provider && input.action.startsWith("lending_") && !policy.allowedLendingProviders.includes(input.provider)) {
      reasons.push(`lending provider ${input.provider} is not allowed`);
    }
    if (typeof input.slippageBps === "number" && input.slippageBps > policy.maxSlippageBps) {
      reasons.push(`slippage ${input.slippageBps} bps exceeds policy max ${policy.maxSlippageBps} bps`);
    }
    if (input.amountMist) {
      const amount = BigInt(input.amountMist);
      const perAction = BigInt(policy.perActionSpendLimitMist);
      if (amount > perAction) reasons.push(`amount ${amount} exceeds per-action cap ${perAction}`);

      const ledger = this.getLedger();
      const projected = BigInt(ledger.spentMist) + amount;
      const daily = BigInt(policy.dailySpendLimitMist);
      if (projected > daily) reasons.push(`projected daily spend ${projected} exceeds cap ${daily}`);
    }

    return {
      decision: reasons.length ? "blocked" : "allowed",
      reasons,
    };
  }
}
