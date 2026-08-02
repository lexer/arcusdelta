/**
 * The exit command's logic, free of process/IO wiring so the confirmation gate
 * is testable.
 *
 * Invariant: `exit` is only reached after `confirm` resolves true, and only
 * once, covering every position that planned successfully across every
 * selected symbol.
 */

import {formatUnits} from 'viem';
import {ArcusTwapPartialFillError} from '../arcus/errors.js';
import type {TokenMeta} from '../uniswap/depositService.js';
import type {ExitPlan, ExitResult} from '../uniswap/positionExitService.js';
import type {OwnedPosition} from '../uniswap/positionReader.js';

/** One symbol's pool: its own positions, prices, and exit service. */
export interface ExitRequestItem {
  readonly symbol: string;
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly positions: readonly OwnedPosition[];
  readonly sqrtPriceX96: bigint;
  readonly exitService: {
    plan(position: OwnedPosition, sqrtPriceX96: bigint): Promise<ExitPlan>;
    exit(plan: ExitPlan): Promise<ExitResult>;
  };
}

/** Per-position outcome. Exactly one of `result`/`error` is set. */
export interface ExitOutcome {
  readonly symbol: string;
  readonly tokenId: bigint;
  readonly result?: ExitResult;
  readonly error?: string;
}

export interface ExitCommandDeps {
  readonly items: readonly ExitRequestItem[];
  /** Resolves true only on explicit operator approval, covering the whole batch. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  /** Report what would happen and stop. */
  readonly dryRun: boolean;
}

interface Planned {
  readonly item: ExitRequestItem;
  readonly plan: ExitPlan;
}

export function buildExitSummary(planned: readonly Planned[]): string {
  const lines = [
    '',
    `About to withdraw ${planned.length} liquidity position${planned.length === 1 ? '' : 's'}, claim fees,`,
    'and sell the resulting stock token(s) back to USDG on Arcus.',
    '',
  ];

  for (const {item, plan} of planned) {
    const {usdg, stock} = item;
    lines.push(
      `  ${item.symbol} #${plan.position.tokenId}  ticks [${plan.position.tickLower}, ${plan.position.tickUpper}]`,
      `    principal  ${formatUnits(plan.principalUsdg, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.principalStock, stock.decimals)} ${stock.symbol}`,
      `    fees       ${formatUnits(plan.fees0, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.fees1, stock.decimals)} ${stock.symbol}`,
      `    at least   ${formatUnits(plan.amount0Min, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.amount1Min, stock.decimals)} ${stock.symbol}`,
    );
  }

  lines.push('', 'This is a PRODUCTION wallet holding real funds.', '');
  return lines.join('\n');
}

/**
 * Returns one outcome per position that planned successfully, or undefined
 * when the operator declined the batch (or it was a dry run). A failure
 * planning or exiting one position does not stop the rest — each position is
 * independent of every other, possibly in a different symbol's pool entirely.
 */
export async function runExitCommand(
  deps: ExitCommandDeps,
): Promise<ExitOutcome[] | undefined> {
  const flatPositions = deps.items.flatMap(item =>
    item.positions.map(position => ({item, position})),
  );

  if (flatPositions.length === 0) {
    deps.print(
      'No open positions across the selected symbols. Nothing to exit.',
    );
    return [];
  }

  const planned: Planned[] = [];
  const planFailures: ExitOutcome[] = [];
  for (const {item, position} of flatPositions) {
    try {
      const plan = await item.exitService.plan(position, item.sqrtPriceX96);
      planned.push({item, plan});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      planFailures.push({
        symbol: item.symbol,
        tokenId: position.tokenId,
        error: message,
      });
      deps.print(
        `${item.symbol} #${position.tokenId}: cannot plan an exit — ${message}`,
      );
    }
  }

  if (planned.length === 0) {
    deps.print('No position could be planned. Nothing to exit.');
    return planFailures;
  }

  const summary = buildExitSummary(planned);

  if (deps.dryRun) {
    deps.print(summary);
    deps.print('  Dry run. Nothing was withdrawn or sold.');
    return undefined;
  }

  if (!(await deps.confirm(summary))) {
    deps.print('Aborted. Nothing was withdrawn.');
    return undefined;
  }

  const outcomes: ExitOutcome[] = [...planFailures];
  for (const {item, plan} of planned) {
    try {
      const result = await item.exitService.exit(plan);
      outcomes.push({
        symbol: item.symbol,
        tokenId: plan.position.tokenId,
        result,
      });

      deps.print(
        `${item.symbol} #${result.tokenId} closed. tx ${result.closeHash}`,
      );
      if (result.stockSold === 0n) {
        deps.print(`  no ${item.stock.symbol} to sell`);
        continue;
      }
      const txWord = (result.saleTxHashes?.length ?? 0) === 1 ? 'tx' : 'txs';
      deps.print(
        `  sold ${formatUnits(result.stockSold, item.stock.decimals)} ${item.stock.symbol}  ${txWord} ${(result.saleTxHashes ?? []).join(', ')}`,
      );
      if (result.usdgReceived !== undefined) {
        deps.print(
          `  received ${formatUnits(BigInt(result.usdgReceived), item.usdg.decimals)} ${item.usdg.symbol}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        symbol: item.symbol,
        tokenId: plan.position.tokenId,
        error: message,
      });
      deps.print(
        `${item.symbol} #${plan.position.tokenId}: exit failed — ${message}`,
      );
      if (error instanceof ArcusTwapPartialFillError) {
        deps.print(
          `  ${error.completedChunks.length} of ${error.totalChunks} chunks already sold — do not retry blindly`,
        );
      }
    }
  }
  return outcomes;
}
