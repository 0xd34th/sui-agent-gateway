export const SUI_COIN_TYPE = "0x2::sui::SUI";

export type PolicyDecision = "allowed" | "blocked";

export type PolicyResult = {
  decision: PolicyDecision;
  reasons: string[];
};

export type AgentPolicy = {
  paused: boolean;
  dailySpendLimitMist: string;
  perActionSpendLimitMist: string;
  maxSlippageBps: number;
  allowedCoinTypes: string[];
  allowedSwapProviders: string[];
  allowedLendingProviders: string[];
  allowedActions: string[];
};

export type SpendLedger = {
  day: string;
  spentMist: string;
};

export type WriteAction =
  | "send"
  | "swap"
  | "native_stake"
  | "native_unstake"
  | "liquid_stake"
  | "liquid_unstake"
  | "lending_supply"
  | "lending_withdraw"
  | "lending_borrow"
  | "cdp_deposit_collateral"
  | "cdp_withdraw_collateral"
  | "cdp_borrow";

export type SwapProviderId = "7k" | "aftermath" | "cetus";

export type SwapQuote = {
  quoteId: string;
  provider: SwapProviderId;
  providerName: string;
  coinInType: string;
  coinOutType: string;
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut?: string;
  estimatedGasMist?: string;
  priceImpactBps?: number;
  slippageBps: number;
  routeSummary: string;
  raw?: unknown;
  expiresAt: string;
};

export type RankedSwapQuote = SwapQuote & {
  rank: number;
  netScore: string;
};
