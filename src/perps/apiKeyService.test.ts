import {describe, expect, it, vi} from 'vitest';
import type {Hex} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import {createLogger} from '../logging/logger.js';
import {
  ApiKeyService,
  apiKeyTypedData,
  DEFAULT_API_WALLET_NAME,
  splitSignature,
} from './apiKeyService.js';
import {PerpsAuthError} from './errors.js';

const logger = createLogger('silent');
const ADDRESS = '0x742D35Cc6634C0532925a3b844Bc9e7595f2BD18';
const NOW = 1_786_269_600_000;
const SIGNATURE = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex;

function makeWallet(signTypedData = vi.fn().mockResolvedValue(SIGNATURE)) {
  const wallet = {
    getAccount: () => ({address: ADDRESS}),
    getWalletClient: () => ({signTypedData}),
    getPublicClient: () => ({}),
  } as unknown as WalletProvider;
  return {wallet, signTypedData};
}

function makeService(
  overrides: {
    createApiKey?: ReturnType<typeof vi.fn>;
    getApiKeys?: ReturnType<typeof vi.fn>;
    wallet?: WalletProvider;
  } = {},
) {
  const createApiKey =
    overrides.createApiKey ??
    vi.fn().mockResolvedValue({
      apiKey: 'aa'.repeat(32),
      address: ADDRESS,
      createdAt: NOW * 1000,
    });
  const getApiKeys = overrides.getApiKeys ?? vi.fn().mockResolvedValue([]);
  const {wallet, signTypedData} = makeWallet();
  const service = new ApiKeyService({
    client: {createApiKey, getApiKeys},
    wallet: overrides.wallet ?? wallet,
    logger,
    chainId: 4663,
    now: () => NOW,
  });
  return {service, createApiKey, getApiKeys, signTypedData};
}

describe('apiKeyTypedData', () => {
  it('omits verifyingContract, since API keys touch no contract', () => {
    const typedData = apiKeyTypedData(4663, 'arcusdelta', 'ab'.repeat(32), NOW);

    expect(typedData.domain).toEqual({
      name: 'Arcus API Key',
      version: '1',
      chainId: 4663,
    });
    expect(typedData.domain).not.toHaveProperty('verifyingContract');
  });

  it('matches the documented primary type and field order', () => {
    const typedData = apiKeyTypedData(4663, 'arcusdelta', 'ab'.repeat(32), NOW);

    expect(typedData.primaryType).toBe('CreateApiKey');
    expect(typedData.types.CreateApiKey.map(field => field.name)).toEqual([
      'apiWalletName',
      'apiWalletPublicKey',
      'validUntil',
    ]);
  });

  it('carries validUntil as a uint256-compatible bigint', () => {
    const typedData = apiKeyTypedData(4663, 'arcusdelta', 'ab'.repeat(32), NOW);

    expect(typedData.message.validUntil).toBe(BigInt(NOW));
  });
});

describe('splitSignature', () => {
  it('splits a 65-byte signature into r, s, and v', () => {
    expect(splitSignature(SIGNATURE)).toEqual({
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      v: '0x1b',
    });
  });

  it('rejects a signature of the wrong length', () => {
    expect(() => splitSignature('0xdeadbeef')).toThrow(PerpsAuthError);
  });
});

describe('ApiKeyService.register', () => {
  it('generates a fresh keypair and registers its public half', async () => {
    const {service, createApiKey} = makeService();

    const registered = await service.register();

    expect(registered.keyPair.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ADDRESS,
        publicKey: registered.keyPair.publicKeyHex,
        apiWalletName: DEFAULT_API_WALLET_NAME,
        signature: splitSignature(SIGNATURE),
      }),
    );
  });

  it('sends the same validUntil it signed', async () => {
    const {service, createApiKey, signTypedData} = makeService();

    await service.register({validityDays: 30});

    const expected = NOW + 30 * 86_400_000;
    expect(createApiKey.mock.calls[0]![0].validUntil).toBe(expected);
    expect(signTypedData.mock.calls[0]![0].message.validUntil).toBe(
      BigInt(expected),
    );
  });

  it('signs the public key that is actually registered', async () => {
    const {service, createApiKey, signTypedData} = makeService();

    const registered = await service.register();

    expect(signTypedData.mock.calls[0]![0].message.apiWalletPublicKey).toBe(
      registered.keyPair.publicKeyHex,
    );
    expect(createApiKey.mock.calls[0]![0].publicKey).toBe(
      registered.keyPair.publicKeyHex,
    );
  });

  it('never generates the same key twice', async () => {
    const {service} = makeService();

    const first = await service.register();
    const second = await service.register();

    expect(first.keyPair.privateKeyHex).not.toBe(second.keyPair.privateKeyHex);
  });

  it('rejects a validity outside the gateway window before signing', async () => {
    const {service, signTypedData} = makeService();

    await expect(service.register({validityDays: 365})).rejects.toThrow(
      PerpsAuthError,
    );
    await expect(service.register({validityDays: 0})).rejects.toThrow(
      PerpsAuthError,
    );
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('ApiKeyService.isRegistered', () => {
  it('accepts a key that is registered and unexpired', async () => {
    const {service} = makeService({
      getApiKeys: vi
        .fn()
        .mockResolvedValue([{apiKey: 'AB'.repeat(32), validUntil: NOW + 1000}]),
    });

    expect(await service.isRegistered('ab'.repeat(32))).toBe(true);
  });

  it('rejects a key whose expiry has passed', async () => {
    const {service} = makeService({
      getApiKeys: vi
        .fn()
        .mockResolvedValue([{apiKey: 'ab'.repeat(32), validUntil: NOW - 1}]),
    });

    expect(await service.isRegistered('ab'.repeat(32))).toBe(false);
  });

  it('accepts a key with no expiry recorded', async () => {
    const {service} = makeService({
      getApiKeys: vi.fn().mockResolvedValue([{apiKey: 'ab'.repeat(32)}]),
    });

    expect(await service.isRegistered('ab'.repeat(32))).toBe(true);
  });

  it('rejects a key that is not registered at all', async () => {
    const {service} = makeService();

    expect(await service.isRegistered('ab'.repeat(32))).toBe(false);
  });
});
