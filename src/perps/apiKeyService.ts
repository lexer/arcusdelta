/**
 * One-time onboarding for the Arcus perps API: generate an Ed25519 keypair
 * and register its public half against the production wallet's address.
 *
 * Arcus is non-custodial — the gateway only ever holds the public key, and
 * registration is gated by an EIP-712 signature from the Ethereum address that
 * will own it. That signature is the only place the wallet is involved; every
 * request afterwards is signed with the Ed25519 key alone.
 *
 * The generated private key is a **secret of the same class as the wallet
 * mnemonic** — anything holding it can place and cancel orders on the account.
 * It is returned once, for the operator to store, and never persisted here.
 */

import type {Hex} from 'viem';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Logger} from '../logging/logger.js';
import type {ArcusPerpsClient} from './arcusPerpsClient.js';
import {PerpsAuthError} from './errors.js';
import {generateApiKeyPair, type ApiKeyPair} from './signing.js';
import type {
  ApiKeyInfo,
  CreateApiKeyResponse,
  EthereumSignature,
} from './types.js';

const MS_PER_DAY = 86_400_000;
/** The gateway accepts an expiry 1–180 days out. */
export const MIN_VALIDITY_DAYS = 1;
export const MAX_VALIDITY_DAYS = 180;
export const DEFAULT_VALIDITY_DAYS = 180;
export const DEFAULT_API_WALLET_NAME = 'arcusdelta';

/**
 * The typed-data domain has no `verifyingContract` — API keys are pure
 * off-chain authentication and never touch a contract.
 */
export function apiKeyTypedData(
  chainId: number,
  apiWalletName: string,
  publicKeyHex: string,
  validUntilMs: number,
) {
  return {
    domain: {name: 'Arcus API Key', version: '1', chainId},
    types: {
      CreateApiKey: [
        {name: 'apiWalletName', type: 'string'},
        {name: 'apiWalletPublicKey', type: 'string'},
        {name: 'validUntil', type: 'uint256'},
      ],
    },
    primaryType: 'CreateApiKey',
    message: {
      apiWalletName,
      apiWalletPublicKey: publicKeyHex,
      validUntil: BigInt(validUntilMs),
    },
  } as const;
}

/** Splits a 65-byte `0x`-hex signature into the `(r, s, v)` triple. */
export function splitSignature(signature: Hex): EthereumSignature {
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new PerpsAuthError(
      `Expected a 65-byte signature, got ${hex.length / 2} bytes`,
    );
  }
  return {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v: `0x${hex.slice(128, 130)}`,
  };
}

export interface ApiKeyServiceOptions {
  readonly client: Pick<ArcusPerpsClient, 'createApiKey' | 'getApiKeys'>;
  readonly wallet: WalletProvider;
  readonly logger: Logger;
  /** Rootchain id — 4663 on mainnet. Part of the EIP-712 domain. */
  readonly chainId: number;
  readonly now?: () => number;
}

export interface RegisterOptions {
  readonly apiWalletName?: string;
  readonly validityDays?: number;
}

export interface RegisteredApiKey {
  readonly keyPair: ApiKeyPair;
  readonly response: CreateApiKeyResponse;
  readonly validUntilMs: number;
}

export class ApiKeyService {
  private readonly client: ApiKeyServiceOptions['client'];
  private readonly wallet: WalletProvider;
  private readonly logger: Logger;
  private readonly chainId: number;
  private readonly now: () => number;

  constructor(options: ApiKeyServiceOptions) {
    this.client = options.client;
    this.wallet = options.wallet;
    this.logger = options.logger;
    this.chainId = options.chainId;
    this.now = options.now ?? (() => Date.now());
  }

  /** Keys already registered to this wallet, live ones and expired alike. */
  async list(): Promise<ApiKeyInfo[]> {
    const address = this.wallet.getAccount().address;
    const keys = await this.client.getApiKeys(address);
    this.logger.info({address, count: keys.length}, 'api keys listed');
    return keys;
  }

  /** True when `apiKeyHex` is registered to this wallet and not yet expired. */
  async isRegistered(apiKeyHex: string): Promise<boolean> {
    const wanted = apiKeyHex.toLowerCase();
    const now = this.now();
    return (await this.list()).some(
      key =>
        key.apiKey.toLowerCase() === wanted &&
        (key.validUntil === undefined || key.validUntil > now),
    );
  }

  /**
   * Generates a fresh keypair and registers it.
   *
   * `validUntil` is always sent explicitly and is exactly the value signed —
   * omitting it makes the server verify against its own 14-day default, which
   * will not match the signature and fails with a misleading 401.
   */
  async register(options: RegisterOptions = {}): Promise<RegisteredApiKey> {
    const apiWalletName = options.apiWalletName ?? DEFAULT_API_WALLET_NAME;
    const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
    if (validityDays < MIN_VALIDITY_DAYS || validityDays > MAX_VALIDITY_DAYS) {
      throw new PerpsAuthError(
        `Key validity must be between ${MIN_VALIDITY_DAYS} and ${MAX_VALIDITY_DAYS} days, got ${validityDays}`,
      );
    }

    const account = this.wallet.getAccount();
    const keyPair = generateApiKeyPair();
    const validUntilMs = this.now() + validityDays * MS_PER_DAY;

    this.logger.info(
      {
        address: account.address,
        apiWalletName,
        validUntilMs,
        chainId: this.chainId,
        publicKey: keyPair.publicKeyHex,
      },
      'registering arcus api key',
    );

    const typedData = apiKeyTypedData(
      this.chainId,
      apiWalletName,
      keyPair.publicKeyHex,
      validUntilMs,
    );
    const signature = await this.wallet.getWalletClient().signTypedData({
      account,
      ...typedData,
    });

    const response = await this.client.createApiKey({
      address: account.address,
      publicKey: keyPair.publicKeyHex,
      apiWalletName,
      validUntil: validUntilMs,
      signature: splitSignature(signature),
    });

    this.logger.info(
      {address: account.address, apiKey: response.apiKey, validUntilMs},
      'arcus api key registered',
    );
    return {keyPair, response, validUntilMs};
  }
}
