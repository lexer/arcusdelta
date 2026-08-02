/**
 * Pure PnL arithmetic. No chain access, no clock.
 *
 * USDG is the numéraire: the strategy starts and ends holding only USDG, so
 * profit is what came back out minus what went in, plus whatever is still
 * deployed. Nothing here needs an external price feed — the stock token is
 * valued at the pool's own price, which is the same price that decides the
 * position's composition.
 */

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const U256 = 2n ** 256n;

/**
 * USDG per whole stock token, as a float for display.
 *
 * The pool price is currency1-per-currency0 in atoms; USDG is currency0 here,
 * so the quote is inverted and rescaled by the decimal difference. Float is
 * fine because this only ever formats a report — every amount that matters
 * stays in atoms.
 */
export function poolPriceUsdgPerStock(
  sqrtPriceX96: bigint,
  usdgDecimals: number,
  stockDecimals: number,
): number {
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = sqrt * sqrt; // stock atoms per USDG atom
  const adjusted = rawPrice * 10 ** (usdgDecimals - stockDecimals);
  if (!Number.isFinite(adjusted) || adjusted === 0) return 0;
  return 1 / adjusted;
}

/**
 * Fees a position has accrued but not yet collected.
 *
 * Fee growth accumulators are unsigned and deliberately allowed to overflow, so
 * the delta is taken modulo 2^256 exactly as the pool intends.
 */
export function accruedFees(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): {fees0: bigint; fees1: bigint} {
  const delta = (current: bigint, last: bigint): bigint =>
    (((current - last) % U256) + U256) % U256;

  return {
    fees0:
      (liquidity * delta(feeGrowthInside0X128, feeGrowthInside0LastX128)) /
      Q128,
    fees1:
      (liquidity * delta(feeGrowthInside1X128, feeGrowthInside1LastX128)) /
      Q128,
  };
}

/**
 * Splits a v3 pool's global fee growth into the amount attributable "inside"
 * a tick range, transcribed from Uniswap's own `Tick.getFeeGrowthInside`
 * (v3-core `Tick.sol`). v4 exposes this as a single StateView call; v3 has no
 * equivalent lens, so it is computed here from the global accumulator and the
 * outside growth recorded at each tick boundary.
 *
 * All arithmetic is modulo 2^256, matching the pool's own unchecked math.
 */
export function computeFeeGrowthInside(
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
  lowerFeeGrowthOutside0X128: bigint,
  lowerFeeGrowthOutside1X128: bigint,
  upperFeeGrowthOutside0X128: bigint,
  upperFeeGrowthOutside1X128: bigint,
): {feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint} {
  const wrap = (value: bigint): bigint => ((value % U256) + U256) % U256;

  const below = (global: bigint, outside: bigint): bigint =>
    tickCurrent >= tickLower ? outside : wrap(global - outside);
  const above = (global: bigint, outside: bigint): bigint =>
    tickCurrent < tickUpper ? outside : wrap(global - outside);

  const below0 = below(feeGrowthGlobal0X128, lowerFeeGrowthOutside0X128);
  const above0 = above(feeGrowthGlobal0X128, upperFeeGrowthOutside0X128);
  const below1 = below(feeGrowthGlobal1X128, lowerFeeGrowthOutside1X128);
  const above1 = above(feeGrowthGlobal1X128, upperFeeGrowthOutside1X128);

  return {
    feeGrowthInside0X128: wrap(feeGrowthGlobal0X128 - below0 - above0),
    feeGrowthInside1X128: wrap(feeGrowthGlobal1X128 - below1 - above1),
  };
}

/** Atoms of a token expressed in whole USDG units. */
export function valueInUsdg(
  stockAtoms: bigint,
  stockDecimals: number,
  priceUsdgPerStock: number,
): number {
  return (Number(stockAtoms) / 10 ** stockDecimals) * priceUsdgPerStock;
}

export interface PnlInputs {
  /** USDG atoms spent buying the stock token on Arcus. */
  readonly usdgSpent: bigint;
  /** USDG atoms received selling the stock token on Arcus. */
  readonly usdgReceived: bigint;
  /**
   * USDG atoms taken from the wallet to fund liquidity positions.
   *
   * This is capital too. It never passes through an Arcus trade, so leaving it
   * out makes the position's USDG side look like profit appearing from nowhere.
   */
  readonly usdgDepositedToLp: bigint;
  /** Stock atoms sitting loose in the wallet. */
  readonly stockBalance: bigint;
  /** Position principal still deployed, at the current price. */
  readonly lpUsdg: bigint;
  readonly lpStock: bigint;
  /** Fees accrued and uncollected. */
  readonly fees0: bigint;
  readonly fees1: bigint;
  readonly usdgDecimals: number;
  readonly stockDecimals: number;
  readonly priceUsdgPerStock: number;
}

export interface PnlBreakdown {
  /** USDG that left the wallet: Arcus buys plus the USDG side of deposits. */
  readonly capitalInUsdg: number;
  /** USDG that came back: Arcus sells. */
  readonly capitalOutUsdg: number;
  /** Still deployed, marked at the pool price. */
  readonly openValueUsdg: number;
  /** Uncollected fees, both sides, in USDG. */
  readonly feesUsdg: number;
  /** (out + open + fees) - in. Positive is profit. */
  readonly netUsdg: number;
  /** netUsdg / capitalInUsdg, or 0 when no capital was ever committed. */
  readonly returnFraction: number;
}

export function computePnl(inputs: PnlInputs): PnlBreakdown {
  const scale = 10 ** inputs.usdgDecimals;
  const spent = Number(inputs.usdgSpent) / scale;
  const received = Number(inputs.usdgReceived) / scale;
  const deposited = Number(inputs.usdgDepositedToLp) / scale;

  const looseStock = valueInUsdg(
    inputs.stockBalance,
    inputs.stockDecimals,
    inputs.priceUsdgPerStock,
  );
  const lpStock = valueInUsdg(
    inputs.lpStock,
    inputs.stockDecimals,
    inputs.priceUsdgPerStock,
  );
  const lpUsdg = Number(inputs.lpUsdg) / scale;

  const feesUsdg =
    Number(inputs.fees0) / scale +
    valueInUsdg(inputs.fees1, inputs.stockDecimals, inputs.priceUsdgPerStock);

  // Stock bought on Arcus is already paid for through usdgSpent, and now shows
  // up inside openValue; the USDG side of a deposit is separate capital.
  const capitalInUsdg = spent + deposited;
  const capitalOutUsdg = received;
  const openValueUsdg = looseStock + lpStock + lpUsdg;
  const netUsdg = capitalOutUsdg + openValueUsdg + feesUsdg - capitalInUsdg;

  return {
    capitalInUsdg,
    capitalOutUsdg,
    openValueUsdg,
    feesUsdg,
    netUsdg,
    returnFraction: capitalInUsdg === 0 ? 0 : netUsdg / capitalInUsdg,
  };
}
