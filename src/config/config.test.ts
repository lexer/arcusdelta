import {describe, expect, it} from 'vitest';
import {ConfigError, loadConfig, loggableConfig} from './config.js';

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const TEST_SEED = 'test test test test test test test test test test test junk';

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SEED: TEST_SEED,
    STOCK_TOKEN_ADDRESS: NVDA,
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

  it('rejects a malformed token address', () => {
    expect(() => loadConfig(validEnv({STOCK_TOKEN_ADDRESS: '0xdead'}))).toThrow(
      ConfigError,
    );
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
