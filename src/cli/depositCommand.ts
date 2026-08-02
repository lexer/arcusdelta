/**
 * The deposit command's logic, kept free of process/IO wiring so the
 * confirmation gate can be tested directly.
 *
 * Invariant: `execute` is only ever reached after `confirm` resolves true,
 * and only once, covering every symbol that planned successfully.
 */

import {formatUnits} from 'viem';
import type {
  DepositPlan,
  DepositResult,
  TokenMeta,
} from '../uniswap/depositService.js';

/** One symbol's deposit, with the service scoped to it. */
export interface DepositRequestItem {
  readonly symbol: string;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly rangeDeviationPercent: number;
  readonly depositService: {
    plan(): Promise<DepositPlan>;
    execute(plan: DepositPlan): Promise<DepositResult>;
  };
}

/** Per-symbol outcome. Exactly one of `result`/`error` is set. */
export interface DepositOutcome {
  readonly symbol: string;
  readonly result?: DepositResult;
  readonly error?: string;
}

export interface DepositCommandDeps {
  readonly items: readonly DepositRequestItem[];
  /** Resolves true only on explicit operator approval, covering the whole batch. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

interface Planned {
  readonly item: DepositRequestItem;
  readonly plan: DepositPlan;
}

/** Price of one stock token in USDG at a given tick, for human display. */
function priceAtTick(tick: number, usdg: TokenMeta, stock: TokenMeta): string {
  // p = 1.0001^tick is token1 per token0 in atoms; USDG is token0.
  const rawPrice = 1.0001 ** tick;
  const adjusted = rawPrice * 10 ** (usdg.decimals - stock.decimals);
  if (!Number.isFinite(adjusted) || adjusted === 0) return 'n/a';
  return (1 / adjusted).toFixed(4);
}

export function buildDepositSummary(planned: readonly Planned[]): string {
  const lines = [
    '',
    `About to open ${planned.length} Uniswap v3 liquidity position${planned.length === 1 ? '' : 's'}`,
    '',
  ];

  for (const {item, plan} of planned) {
    const {usdg, stock} = item;
    lines.push(
      `  ${item.symbol}  ${usdg.symbol}/${stock.symbol}`,
      `    deposit      ${formatUnits(plan.stockAmount, stock.decimals)} ${stock.symbol} + ${formatUnits(plan.usdgAmount, usdg.decimals)} ${usdg.symbol}`,
      `    max pull     ${formatUnits(plan.amount0Desired, usdg.decimals)} ${usdg.symbol} / ${formatUnits(plan.amount1Desired, stock.decimals)} ${stock.symbol}`,
      `    min accepted ${formatUnits(plan.amount0Min, usdg.decimals)} ${usdg.symbol} / ${formatUnits(plan.amount1Min, stock.decimals)} ${stock.symbol}`,
      `    range        ticks ${plan.tickLower} to ${plan.tickUpper} (±${item.rangeDeviationPercent}%)`,
      `    price band   ${priceAtTick(plan.tickUpper, usdg, stock)} to ${priceAtTick(plan.tickLower, usdg, stock)} ${usdg.symbol} per ${stock.symbol}`,
      `    pool price   ${priceAtTick(plan.currentTick, usdg, stock)} ${usdg.symbol} per ${stock.symbol} (tick ${plan.currentTick})`,
      `    liquidity    ${plan.liquidity}`,
      '',
    );
  }

  lines.push('This is a PRODUCTION wallet holding real funds.', '');
  return lines.join('\n');
}

/**
 * Returns one outcome per selected symbol, or undefined when the operator
 * declined the whole batch. A planning or execution failure on one symbol
 * does not stop the rest — each deposit is independent of every other.
 */
export async function runDepositCommand(
  deps: DepositCommandDeps,
): Promise<DepositOutcome[] | undefined> {
  if (deps.items.length === 0) {
    deps.print('No symbols selected to deposit.');
    return [];
  }

  const planned: Planned[] = [];
  const planFailures: DepositOutcome[] = [];
  for (const item of deps.items) {
    try {
      const plan = await item.depositService.plan();
      planned.push({item, plan});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      planFailures.push({symbol: item.symbol, error: message});
      deps.print(`${item.symbol}: cannot plan a deposit — ${message}`);
    }
  }

  if (planned.length === 0) {
    deps.print('No symbol could be planned. Nothing to deposit.');
    return planFailures;
  }

  if (!(await deps.confirm(buildDepositSummary(planned)))) {
    deps.print('Aborted. No position was opened.');
    return undefined;
  }

  const outcomes: DepositOutcome[] = [...planFailures];
  for (const {item, plan} of planned) {
    try {
      const result = await item.depositService.execute(plan);
      outcomes.push({symbol: item.symbol, result});

      deps.print(`${item.symbol}: position opened. tx ${result.hash}`);
      if (result.tokenId !== undefined) {
        deps.print(`  position NFT #${result.tokenId}`);
      }
      for (const hash of result.approvalHashes) {
        deps.print(`  approval tx  ${hash}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({symbol: item.symbol, error: message});
      deps.print(`${item.symbol}: deposit failed — ${message}`);
    }
  }
  return outcomes;
}
