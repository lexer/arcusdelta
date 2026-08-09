import {describe, expect, it} from 'vitest';
import {ConfigError, loadConfig, loggableConfig} from './config.js';

const TEST_SEED = 'test test test test test test test test test test test junk';

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SEED: TEST_SEED,
    USDG_BUY_AMOUNT: '100',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('applies Robinhood Chain defaults', () => {
    const config = loadConfig(validEnv());

    expect(config.rpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(config.chainId).toBe(4663);
    expect(config.arcusRouterUrl).toBe('https://router.spot.arcus.xyz/v1');
    expect(config.slippageBps).toBe(1);
  });

  it('applies pair monitoring defaults', () => {
    const config = loadConfig(validEnv());

    expect(config.minCloseProfitBps).toBe(25);
    expect(config.maxDeltaBps).toBe(100);
    expect(config.pairCheckIntervalSeconds).toBe(60);
  });

  it('applies perps defaults', () => {
    const config = loadConfig(validEnv());

    expect(config.arcusApiUrl).toBe('https://api.arcus.xyz');
    expect(config.arcusAccountIndex).toBe(0);
    expect(config.arcusApiPrivateKey).toBeUndefined();
  });

  it('applies TWAP defaults, disabled by default', () => {
    const config = loadConfig(validEnv());

    expect(config.twapChunks).toBe(1);
    expect(config.twapIntervalSeconds).toBe(10);
  });

  it('rejects a zero TWAP chunk count', () => {
    expect(() => loadConfig(validEnv({TWAP_CHUNKS: '0'}))).toThrow(ConfigError);
  });

  it('applies the price impact default', () => {
    const config = loadConfig(validEnv());

    expect(config.maxPriceImpactBps).toBe(100);
  });

  it('rejects a price impact threshold outside the basis-point range', () => {
    expect(() => loadConfig(validEnv({MAX_PRICE_IMPACT_BPS: '10001'}))).toThrow(
      ConfigError,
    );
  });

  it('rejects a zero pair check interval', () => {
    expect(() =>
      loadConfig(validEnv({PAIR_CHECK_INTERVAL_SECONDS: '0'})),
    ).toThrow(ConfigError);
  });

  it('rejects a malformed Arcus API private key', () => {
    expect(() =>
      loadConfig(validEnv({ARCUS_API_PRIVATE_KEY: 'not-a-key'})),
    ).toThrow(ConfigError);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig(
      validEnv({CHAIN_ID: '46630', SLIPPAGE_BPS: '50', USDG_BUY_AMOUNT: '5.5'}),
    );

    expect(config.chainId).toBe(46630);
    expect(config.slippageBps).toBe(50);
    expect(config.usdgBuyAmount).toBe('5.5');
  });

  it('rejects a missing seed', () => {
    expect(() => loadConfig(validEnv({SEED: undefined}))).toThrow(ConfigError);
  });

  it('leaves usdgBuyAmount undefined when unset, rather than defaulting it', () => {
    const config = loadConfig(validEnv({USDG_BUY_AMOUNT: undefined}));

    expect(config.usdgBuyAmount).toBeUndefined();
  });

  it('rejects a non-positive buy amount', () => {
    expect(() => loadConfig(validEnv({USDG_BUY_AMOUNT: '0'}))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(validEnv({USDG_BUY_AMOUNT: '-5'}))).toThrow(
      ConfigError,
    );
  });

  it('rejects slippage outside the basis-point range', () => {
    expect(() => loadConfig(validEnv({SLIPPAGE_BPS: '10001'}))).toThrow(
      ConfigError,
    );
  });
});

describe('loggableConfig', () => {
  it('omits the seed', () => {
    const fields = loggableConfig(loadConfig(validEnv()));

    expect(fields).not.toHaveProperty('seed');
    expect(JSON.stringify(fields)).not.toContain(TEST_SEED);
  });
});
