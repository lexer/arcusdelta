/**
 * End-to-end rehearsal of the delta-neutral pair at ~$12, on a one-hour clock.
 * One-off, deleted after the run.
 *
 * Invariants, in order of importance:
 *  1. Never sell the spot leg while the perp short is still open. That would
 *     leave the account net short — the one state this strategy must never
 *     reach by accident.
 *  2. Maker only on both legs. If a leg does not fill, stop; do not cross.
 *  3. The single authorized exception: if the perp short fills and the spot
 *     buy then fails, unwind the perp as a taker rather than hold an unhedged
 *     leveraged short.
 *
 * The hold is a full hour so the pair crosses a funding boundary and the
 * journal captures a real payment.
 */

import 'dotenv/config';
import {erc20Abi, formatUnits, type Hex} from 'viem';
import {loadConfig} from './src/config/config.js';
import {createContainer} from './src/di/container.js';
import {FundingRecorder} from './src/journal/fundingRecorder.js';
import {totalFunding} from './src/journal/executionJournal.js';
import {ArcusPerpsClient} from './src/perps/arcusPerpsClient.js';
import {AuthenticatedPerpsClient} from './src/perps/authenticatedPerpsClient.js';
import {MakerOrderExecutor} from './src/perps/makerOrderExecutor.js';
import {MarketRegistry} from './src/perps/marketRegistry.js';
import {PerpsShortService} from './src/perps/perpsShortService.js';
import {PerpsRequestSigner} from './src/perps/signing.js';
import {
  absDecimals,
  floorToIncrement,
  multiplyDecimals,
  subtractDecimals,
} from './src/perps/decimal.js';

const NVDA: Hex = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const MARKET = 'NVDA-USD';
const TARGET_QTY = '0.053';

/** One hour of maker attempts per leg: 12 postings, 5 minutes each. */
const REPRICE_SECONDS = 300;
const MAX_ATTEMPTS = 12;
const IMPROVE_TICKS = 1;
/** One hour, so the pair crosses at least one hourly funding payment. */
const HOLD_SECONDS = 3600;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const step = (n: string) => console.log(`\n===== [${stamp()}] ${n} =====`);

const config = loadConfig();
const container = createContainer(config);
const {logger, wallet, swapService, journal} = container;
const address = wallet.getAccount().address;

const reader = new ArcusPerpsClient({baseUrl: config.arcusApiUrl, logger});
const client = new AuthenticatedPerpsClient({
  baseUrl: config.arcusApiUrl,
  logger,
  signer: new PerpsRequestSigner(config.arcusApiPrivateKey!),
  address,
  accountIndex: config.arcusAccountIndex,
});
const registry = new MarketRegistry(reader);
const executor = new MakerOrderExecutor({
  client,
  marketData: reader,
  journal,
  logger,
});
const shorts = new PerpsShortService({
  client,
  marketData: reader,
  executor,
  journal,
  logger,
  address,
  accountIndex: config.arcusAccountIndex,
});
const funding = new FundingRecorder({
  client: reader,
  journal,
  logger,
  address,
  accountIndex: config.arcusAccountIndex,
});
const resolveNvda = (market: string) =>
  market === MARKET ? 'NVDA' : undefined;

const spec = await registry.byMarket(MARKET);
const tradeId = `seq-${Date.now()}`;

async function nvdaBalance(): Promise<bigint> {
  return wallet.getPublicClient().readContract({
    address: NVDA,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}

function recordSpot(
  direction: 'buy' | 'sell',
  sellSymbol: string,
  buySymbol: string,
  result: {sellAmount: string; buyAmount: string; txHashes: readonly Hex[]},
): void {
  journal.record({
    kind: 'spot-fill',
    at: new Date().toISOString(),
    tradeId,
    symbol: 'NVDA',
    direction,
    sellSymbol,
    buySymbol,
    sellAmount: result.sellAmount,
    buyAmount: result.buyAmount,
    txHashes: result.txHashes,
  });
}

step('0. guards');
await shorts.assertNoExistingPosition(spec);
await shorts.assertSufficientCollateral(spec, TARGET_QTY, spec.tickSize, 1);
const startingBalance = await nvdaBalance();
console.log('no NVDA perp position; starting spot NVDA atoms:', startingBalance);
console.log(
  `open window: ${MAX_ATTEMPTS} x ${REPRICE_SECONDS}s = ${(MAX_ATTEMPTS * REPRICE_SECONDS) / 60} min, improveTicks ${IMPROVE_TICKS}`,
);

step('1. perp: post-only SELL, one tick in front of the touch');
const opened = await shorts.openShort({
  tradeId,
  symbol: 'NVDA',
  spec,
  quantity: TARGET_QTY,
  repriceSeconds: REPRICE_SECONDS,
  maxAttempts: MAX_ATTEMPTS,
  improveTicks: IMPROVE_TICKS,
});
console.log('open result:', opened);

if (opened.filledQuantity === '0') {
  console.log('\nNothing filled as a maker within the hour. Aborting — nothing to unwind.');
  process.exit(0);
}

const shortQty = opened.filledQuantity;
const fillPrice = opened.averageFillPrice!;
console.log(`perp short opened: ${shortQty} NVDA @ ${fillPrice}`);

step('2. spot: buy NVDA to match the short');
const spend = multiplyDecimals(shortQty, fillPrice);
console.log('spending', spend, 'USDG');
let boughtAtoms = 0n;
try {
  const buy = await swapService.executeBuy({
    tradeId,
    buyToken: NVDA,
    sellAmount: spend,
    slippageBps: 50,
    maxPriceImpactBps: 100,
  });
  recordSpot('buy', 'USDG', 'NVDA', buy);
  boughtAtoms = BigInt(buy.buyAmount);
  console.log('spot buy settled:', buy.txHashes);
} catch (error) {
  console.error('\nSPOT BUY FAILED:', (error as Error).message);
  console.error('Unwinding the perp as a taker rather than hold it naked.');
  const live = await registry.live(MARKET);
  await shorts.unwindShort(tradeId, 'NVDA', spec, shortQty, live.markPrice, 100);
  process.exit(1);
}

console.log('wallet NVDA:', formatUnits(await nvdaBalance(), 18));
console.log(
  'residual delta (spot - short):',
  subtractDecimals(formatUnits(boughtAtoms, 18), shortQty),
);

step(`3. holding the hedged pair for ${HOLD_SECONDS / 60} min`);
for (let elapsed = 0; elapsed < HOLD_SECONDS; elapsed += 600) {
  await sleep(Math.min(600, HOLD_SECONDS - elapsed) * 1000);
  const p = await shorts.positionFor(MARKET);
  console.log(
    `[${stamp()}] +${(elapsed + 600) / 60}min  position ${p?.side} ${p?.size}  funding ${JSON.stringify(p?.cumulativeFunding)}  upnl ${p?.unrealizedPnl}`,
  );
}

step('3b. record earned funding');
console.log('funding sync:', await funding.sync(resolveNvda));

step('4. unwind the perp FIRST: reduce-only post-only BUY');
const position = await shorts.positionFor(MARKET);
if (!position) {
  console.log('no perp position to close');
} else {
  const closeQty = floorToIncrement(absDecimals(position.size), spec.stepSize);
  console.log('closing', closeQty);
  const closed = await shorts.closeShort({
    tradeId,
    symbol: 'NVDA',
    spec,
    quantity: closeQty,
    repriceSeconds: REPRICE_SECONDS,
    maxAttempts: MAX_ATTEMPTS,
    improveTicks: IMPROVE_TICKS,
  });
  console.log('close result:', closed);

  const after = await shorts.positionFor(MARKET);
  if (after) {
    console.log(`\nPerp still open: ${after.side} ${after.size}.`);
    console.log('NOT selling the spot leg — that would leave the account net short.');
    console.log('The pair stays open and hedged. Close it when a maker fill is available.');
    process.exit(0);
  }
  console.log('perp fully closed');
}

step('5. spot: sell NVDA back to USDG');
const sellable = (await nvdaBalance()) - startingBalance;
if (sellable <= 0n) {
  console.log('nothing to sell back');
} else {
  const sold = await swapService.executeSell({
    tradeId,
    sellToken: NVDA,
    sellAmountAtoms: sellable,
    slippageBps: 50,
  });
  recordSpot('sell', 'NVDA', 'USDG', sold);
  console.log('spot sell settled:', sold.txHashes);
}

step('final state');
console.log('open orders:', (await client.getOpenOrders()).length);
const finalPos = await shorts.positionFor(MARKET);
console.log('NVDA perp position:', finalPos ? `${finalPos.side} ${finalPos.size}` : 'none');
console.log('wallet NVDA:', formatUnits(await nvdaBalance(), 18));
console.log('NVDA funding earned:', totalFunding(journal.read(), 'NVDA').toFixed(8));
console.log('\njournal for this run:');
for (const e of journal.read()) {
  if ('tradeId' in e && e.tradeId === tradeId) console.log(' ', JSON.stringify(e));
}
for (const e of journal.read()) {
  if (e.kind === 'funding' && e.symbol === 'NVDA') console.log(' ', JSON.stringify(e));
}
