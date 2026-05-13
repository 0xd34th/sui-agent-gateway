#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listTradableAssets, resolveTradableAsset } from "./assets.js";
import { CdpService } from "./cdp.js";
import { loadConfig } from "./config.js";
import { DefiActivityService } from "./defi-activities.js";
import { listSuiDefiProtocols } from "./defillama.js";
import { Keystore } from "./keystore.js";
import { LendingProviderId, LendingService } from "./lending.js";
import { LiquidStakingService } from "./liquid-staking.js";
import { PolicyStore } from "./policy.js";
import { listLiquidityProtocols, listProtocolIntegrations } from "./protocols.js";
import { createSuiClient, resolveRecipient, SuiWalletService } from "./sui.js";
import { SwapService } from "./swaps.js";
import { SwapProviderId } from "./types.js";

const config = loadConfig();
const client = createSuiClient(config);
const keystore = new Keystore(config);
const policy = new PolicyStore(config);
const wallet = new SuiWalletService(config, client, keystore, policy);
const swaps = new SwapService(config, client, keystore, policy);
const liquidStaking = new LiquidStakingService(config, client, keystore, policy);
const lending = new LendingService(config, client, keystore, policy);
const cdp = new CdpService(config, client, keystore, policy);
const defiActivities = new DefiActivityService();

const server = new McpServer({
  name: "sui-agent-gateway",
  version: "0.1.0",
});

const providerSchema = z.enum(["7k", "aftermath", "cetus"]);
const boolDefaultFalse = z.boolean().optional().default(false);
const liquidStakingProviderSchema = z.enum(["aftermath", "springsui", "haedal", "volo", "alphafi"]);
const lendingProviderSchema = z.enum(["scallop", "navi", "suilend", "alphalend", "current"]);
const protocolSlugSchema = z.string().min(1);
const tradableAssetCategorySchema = z.enum(["rwa_precious_metal"]);
const defiActivitySchema = z.enum([
  "swap",
  "native_stake",
  "liquid_stake",
  "lp_deposit",
  "vault_deposit",
  "rwa_swap",
  "lending_supply",
  "lending_borrow",
  "cdp_deposit",
  "cdp_mint",
  "perps_trade",
]);

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, bigintReplacer, 2),
      },
    ],
  };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function registerTool<Input extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: z.ZodObject<Input>,
  handler: (args: z.output<z.ZodObject<Input>>) => Promise<unknown> | unknown,
) {
  server.registerTool(name, { description, inputSchema: inputSchema.shape } as never, async (args: unknown) => {
    try {
      return jsonResult(await handler(args as z.output<z.ZodObject<Input>>)) as never;
    } catch (error) {
      return jsonResult({
        error: error instanceof Error ? error.message : String(error),
      }) as never;
    }
  });
}

registerTool(
  "create_agent_wallet",
  "Create or return the capped Sui sub-wallet used by this agent.",
  z.object({ overwrite: z.boolean().optional().default(false) }),
  ({ overwrite }) => ({ ...keystore.create(overwrite), network: config.network, writesEnabled: config.network !== "mainnet" || config.allowMainnetWrites }),
);

registerTool("get_address", "Return the agent wallet address.", z.object({}), () => ({
  address: keystore.getAddress(),
  network: config.network,
}));

registerTool("receive", "Return receive details for funding the agent sub-wallet.", z.object({}), () => wallet.receive());

registerTool(
  "resolve_suins_name",
  "Resolve a Sui address or SuiNS name to a Sui address.",
  z.object({ recipient: z.string() }),
  ({ recipient }) => resolveRecipient(client, recipient),
);

registerTool("get_balances", "Return all balances for the agent wallet.", z.object({}), () => wallet.getBalances());
registerTool("get_portfolio", "Return balances enriched with coin metadata.", z.object({}), () => wallet.getPortfolio());
registerTool("get_policy", "Return the current wallet policy.", z.object({}), () => policy.get());

registerTool(
  "update_policy",
  "Patch the current wallet policy.",
  z.object({
    paused: z.boolean().optional(),
    dailySpendLimitMist: z.string().optional(),
    perActionSpendLimitMist: z.string().optional(),
    maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
    allowedCoinTypes: z.array(z.string()).optional(),
    allowedSwapProviders: z.array(providerSchema).optional(),
    allowedLendingProviders: z.array(lendingProviderSchema).optional(),
    allowedActions: z.array(z.string()).optional(),
  }),
  (patch) => policy.update(patch),
);

registerTool(
  "pause_wallet",
  "Pause or unpause all write actions.",
  z.object({ paused: z.boolean().default(true) }),
  ({ paused }) => policy.setPaused(paused),
);

registerTool(
  "send",
  "Send SUI or another coin from the capped wallet to a Sui address or SuiNS name.",
  z.object({
    recipient: z.string(),
    amount: z.string(),
    coinType: z.string().optional(),
    amountIsBaseUnits: z.boolean().optional().default(false),
    dryRun: boolDefaultFalse,
  }),
  (args) => wallet.send(args),
);

registerTool("list_swap_providers", "List configured swap quote providers.", z.object({}), () => swaps.listProviders());

registerTool(
  "list_tradable_assets",
  "List curated assets that agents can trade through normal swap tools, including Matrixdock gold and silver.",
  z.object({ category: tradableAssetCategorySchema.optional(), query: z.string().optional() }),
  (args) => listTradableAssets(args),
);

registerTool(
  "resolve_tradable_asset",
  "Resolve a user-friendly asset name such as gold, silver, XAUM, or XAGM into its Sui coin type.",
  z.object({ query: z.string() }),
  (args) => resolveTradableAsset(args),
);

registerTool("list_defi_activities", "List agent DeFi activities and their implementation/policy status.", z.object({}), () => defiActivities.listActivities());

registerTool(
  "list_protocol_integrations",
  "List explicit adapter status for named Sui protocols from the tracked top Sui DeFi set.",
  z.object({ slugs: z.array(protocolSlugSchema).optional() }),
  (args) => listProtocolIntegrations(args),
);

registerTool("list_liquidity_protocols", "List DEX, LP, vault, and trading protocols tracked by the gateway.", z.object({}), () => listLiquidityProtocols());

registerTool(
  "list_sui_defi_protocols",
  "List current top Sui DeFi protocols from DeFiLlama with agent activity and adapter status.",
  z.object({ limit: z.number().int().min(1).max(100).optional().default(30) }),
  ({ limit }) => listSuiDefiProtocols(limit),
);

registerTool(
  "get_defi_action_plan",
  "Return the execution status, policy requirements, and next adapter work for a DeFi protocol/category/action.",
  z.object({
    protocolSlug: z.string().optional(),
    category: z.string().optional(),
    action: defiActivitySchema.optional(),
  }),
  (args) => defiActivities.getActionPlan(args),
);

const quoteSchema = z.object({
  coinInType: z.string(),
  coinOutType: z.string(),
  amountIn: z.string(),
  amountIsBaseUnits: z.boolean().optional().default(false),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
});

registerTool(
  "quote_swap",
  "Return a quote from one swap provider.",
  quoteSchema.extend({ provider: providerSchema }),
  ({ provider, ...args }) => swaps.quoteOne(provider as SwapProviderId, args),
);

registerTool("quote_all_swaps", "Quote all enabled swap providers and rank the best net output.", quoteSchema, (args) => swaps.quoteAll(args));

registerTool(
  "execute_swap",
  "Execute, dry-run, or prepare the best/provider-selected swap quote under policy.",
  quoteSchema.extend({
    provider: providerSchema.optional(),
    quoteId: z.string().optional(),
    dryRun: boolDefaultFalse,
  }),
  (args) => swaps.execute(args),
);

registerTool(
  "list_validators",
  "List active native Sui validators from the Sui gRPC system state.",
  z.object({ limit: z.number().int().min(1).max(500).optional().default(50) }),
  ({ limit }) => wallet.listValidators(limit),
);

registerTool(
  "quote_native_stake",
  "Quote native SUI staking with chain preflight. If no validator is supplied, pick an active default validator.",
  z.object({ amountSui: z.string(), validatorAddress: z.string().optional(), preflight: z.boolean().optional().default(true) }),
  (args) => wallet.quoteNativeStake(args),
);

registerTool(
  "native_stake_sui",
  "Stake SUI natively after chain preflight. If no validator is supplied, pick an active default validator.",
  z.object({ amountSui: z.string(), validatorAddress: z.string().optional(), dryRun: boolDefaultFalse }),
  (args) => wallet.nativeStake(args),
);

registerTool(
  "native_unstake_sui",
  "Withdraw a native StakedSui object.",
  z.object({ stakedSuiObjectId: z.string(), dryRun: boolDefaultFalse }),
  (args) => wallet.nativeUnstake(args),
);

registerTool("get_native_stakes", "List native StakedSui objects owned by the wallet.", z.object({}), () => wallet.getNativeStakes());

registerTool("list_lending_providers", "List lending providers and current adapter status.", z.object({}), () => lending.listProviders());

registerTool(
  "list_lending_markets",
  "List supply markets for an implemented lending provider, starting with Scallop.",
  z.object({ provider: lendingProviderSchema.optional() }),
  (args) => lending.listMarkets(args as { provider?: LendingProviderId }),
);

const lendingAmountSchema = z.object({
  provider: lendingProviderSchema.optional(),
  coin: z.string(),
  amount: z.string(),
  amountIsBaseUnits: z.boolean().optional().default(false),
});

registerTool(
  "quote_lending_supply",
  "Quote a lending deposit. Scallop and Suilend are SDK-backed.",
  lendingAmountSchema,
  (args) => lending.quoteSupply(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }),
);

registerTool(
  "lending_supply",
  "Dry-run or execute a lending deposit under policy.",
  lendingAmountSchema.extend({ dryRun: boolDefaultFalse }),
  (args) => lending.supply(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }),
);

registerTool(
  "quote_lending_withdraw",
  "Quote a lending withdraw from a supplied market.",
  lendingAmountSchema,
  (args) => lending.quoteWithdraw(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }),
);

registerTool(
  "lending_withdraw",
  "Dry-run or execute a lending withdraw under policy.",
  lendingAmountSchema.extend({ dryRun: boolDefaultFalse }),
  (args) => lending.withdraw(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }),
);

registerTool(
  "quote_lending_borrow",
  "Return a real borrow quote with risk controls. Implemented providers require an existing obligation/collateral account.",
  z.object({ provider: lendingProviderSchema.optional(), coin: z.string(), amount: z.string(), amountIsBaseUnits: z.boolean().optional().default(false) }),
  (args) => lending.quoteBorrow(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean }),
);

registerTool(
  "lending_borrow",
  "Build, dry-run, or execute a real borrow transaction for an implemented lending provider.",
  z.object({ provider: lendingProviderSchema.optional(), coin: z.string(), amount: z.string(), amountIsBaseUnits: z.boolean().optional().default(false), dryRun: boolDefaultFalse }),
  (args) => lending.borrow(args as { provider?: LendingProviderId; coin: string; amount: string; amountIsBaseUnits?: boolean; dryRun?: boolean }),
);

registerTool(
  "get_lending_positions",
  "List lending positions for an implemented provider.",
  z.object({ provider: lendingProviderSchema.optional() }),
  (args) => lending.getPositions(args as { provider?: LendingProviderId }),
);

registerTool("list_cdp_providers", "List CDP providers and policy status. Borrow/mint is blocked by default.", z.object({}), () => cdp.listProviders());

registerTool("list_bucket_collateral_types", "List Bucket collateral types and vault metadata.", z.object({}), () => cdp.listBucketCollateralTypes());

registerTool("get_bucket_positions", "List Bucket CDP positions and savings for the agent wallet.", z.object({}), () => cdp.getBucketPositions());

const bucketCollateralSchema = z.object({
  coinType: z.string(),
  amount: z.string(),
  amountIsBaseUnits: z.boolean().optional().default(false),
});

registerTool(
  "quote_bucket_deposit_collateral",
  "Quote a Bucket collateral-only deposit.",
  bucketCollateralSchema,
  (args) => cdp.quoteBucketDepositCollateral(args),
);

registerTool(
  "bucket_deposit_collateral",
  "Dry-run or execute a Bucket collateral-only deposit under policy.",
  bucketCollateralSchema.extend({ dryRun: boolDefaultFalse }),
  (args) => cdp.bucketDepositCollateral(args),
);

registerTool(
  "quote_bucket_borrow_usdb",
  "Return a real Bucket USDB borrow/mint quote with risk controls.",
  z.object({
    coinType: z.string(),
    borrowAmount: z.string(),
    borrowAmountIsBaseUnits: z.boolean().optional().default(false),
    depositAmount: z.string().optional(),
    depositAmountIsBaseUnits: z.boolean().optional().default(false),
  }),
  (args) => cdp.quoteBucketBorrow(args),
);

registerTool(
  "bucket_borrow_usdb",
  "Build, dry-run, or execute a real Bucket USDB borrow/mint manage-position transaction.",
  z.object({
    coinType: z.string(),
    borrowAmount: z.string(),
    borrowAmountIsBaseUnits: z.boolean().optional().default(false),
    depositAmount: z.string().optional(),
    depositAmountIsBaseUnits: z.boolean().optional().default(false),
    dryRun: boolDefaultFalse,
  }),
  (args) => cdp.bucketBorrowUsdb(args),
);

registerTool("list_liquid_stake_providers", "List liquid staking providers and execution support status.", z.object({}), () => liquidStaking.listProviders());

registerTool(
  "quote_liquid_stake",
  "Quote liquid staking SUI. Aftermath afSUI supports SDK preflight; other providers report adapter status.",
  z.object({ amountSui: z.string(), provider: liquidStakingProviderSchema.optional(), preflight: z.boolean().optional().default(true) }),
  (args) => liquidStaking.quoteStake(args),
);

registerTool(
  "liquid_stake_sui",
  "Liquid stake SUI through an implemented provider, with dry-run support.",
  z.object({ amountSui: z.string(), provider: liquidStakingProviderSchema.optional(), dryRun: boolDefaultFalse }),
  (args) => liquidStaking.stake(args),
);

registerTool(
  "quote_liquid_unstake",
  "Quote liquid unstaking from an LST back to SUI.",
  z.object({ amount: z.string(), provider: liquidStakingProviderSchema.optional(), amountIsBaseUnits: z.boolean().optional().default(true), atomic: z.boolean().optional().default(true) }),
  (args) => liquidStaking.quoteUnstake(args),
);

registerTool(
  "liquid_unstake_sui",
  "Liquid unstake through an implemented provider, with dry-run support.",
  z.object({
    amount: z.string(),
    provider: liquidStakingProviderSchema.optional(),
    lstCoinObjectId: z.string().optional(),
    amountIsBaseUnits: z.boolean().optional().default(true),
    atomic: z.boolean().optional().default(true),
    dryRun: boolDefaultFalse,
  }),
  (args) => liquidStaking.unstake(args),
);

registerTool(
  "get_liquid_stake_positions",
  "List liquid staking positions for an implemented provider.",
  z.object({ provider: liquidStakingProviderSchema.optional() }),
  (args) => liquidStaking.getPositions(args),
);

await server.connect(new StdioServerTransport());
