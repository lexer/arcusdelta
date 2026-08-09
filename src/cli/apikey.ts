/**
 * Entrypoint for `npm run apikey` — one-time onboarding for the Arcus perps
 * API.
 *
 * Generates an Ed25519 keypair, registers the public half against the
 * production wallet with an EIP-712 signature, and prints the private half
 * once for the operator to put in `.env`. Nothing is written to disk here:
 * the key is a secret of the same class as `SEED`, and this bot does not
 * decide where the operator's secrets live.
 *
 * `--list` is read-only and shows what is already registered.
 */

import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createRobinhoodChain} from '../chain/robinhoodChain.js';
import {createWalletProvider} from '../chain/walletProvider.js';
import {createRunLogger} from '../di/observability.js';
import {ApiKeyService} from '../perps/apiKeyService.js';
import {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {PerpsError} from '../perps/errors.js';
import {print, promptYes, alwaysYes} from './prompt.js';

function formatKeyList(
  keys: readonly {
    apiKey: string;
    apiWalletName?: string;
    validUntil?: number;
  }[],
  nowMs: number,
): string {
  if (keys.length === 0) return '  (none registered)';
  return keys
    .map(key => {
      const expiry =
        key.validUntil === undefined
          ? 'no expiry'
          : `${key.validUntil <= nowMs ? 'EXPIRED' : 'valid until'} ${new Date(
              key.validUntil,
            ).toISOString()}`;
      return `  ${key.apiKey}  ${key.apiWalletName ?? '-'}  ${expiry}`;
    })
    .join('\n');
}

async function main(): Promise<number> {
  const program = new Command()
    .name('apikey')
    .description('Generate and register an Arcus perps API key')
    .option('--list', 'only list the keys already registered to this wallet')
    .option('--name <name>', 'API wallet name recorded with the key')
    .option('--days <n>', 'validity in days (1-180, default 180)')
    .option('-y, --yes', 'skip the interactive confirmation')
    .parse(process.argv);
  const options = program.opts<{
    list?: boolean;
    name?: string;
    days?: string;
    yes?: boolean;
  }>();

  const config = loadConfig();
  const logger = createRunLogger(config);
  const chain = createRobinhoodChain(config.rpcUrl, config.chainId);
  const wallet = createWalletProvider(config.seed, chain, config.rpcUrl);
  const client = new ArcusPerpsClient({
    baseUrl: config.arcusApiUrl,
    logger,
  });
  const service = new ApiKeyService({
    client,
    wallet,
    logger,
    chainId: config.chainId,
  });
  const address = wallet.getAccount().address;

  logger.info(
    {command: 'apikey', list: options.list === true, ...loggableConfig(config)},
    'cli started',
  );

  try {
    const existing = await service.list();
    print('');
    print(`API keys registered to ${address}:`);
    print(formatKeyList(existing, Date.now()));
    print('');

    if (options.list) return 0;

    const validityDays = options.days ? Number(options.days) : undefined;
    const confirm = options.yes ? alwaysYes : promptYes;
    const approved = await confirm(
      [
        `About to register a NEW Arcus perps API key for ${address}`,
        `on ${config.arcusApiUrl} (chain ${config.chainId}).`,
        '',
        'This signs an EIP-712 message with the production wallet. It moves no',
        'funds, but the resulting key can place and cancel orders on the perps',
        'account — treat it exactly like the seed phrase.',
        '',
      ].join('\n'),
    );
    if (!approved) {
      print('Aborted. No key was generated or registered.');
      return 1;
    }

    const registered = await service.register({
      ...(options.name === undefined ? {} : {apiWalletName: options.name}),
      ...(validityDays === undefined ? {} : {validityDays}),
    });

    print('');
    print('Registered. Add this line to your .env and keep it secret:');
    print('');
    print(`ARCUS_API_PRIVATE_KEY=${registered.keyPair.privateKeyHex}`);
    print('');
    print(`  public key (the API key)  ${registered.keyPair.publicKeyHex}`);
    print(
      `  valid until               ${new Date(registered.validUntilMs).toISOString()}`,
    );
    print('');
    print(
      'The gateway accepts the key asynchronously — give it a moment before',
    );
    print('the first authenticated request.');
    print('');

    logger.info({outcome: 'registered'}, 'cli finished');
    return 0;
  } catch (error) {
    const context = error instanceof PerpsError ? {name: error.name} : {};
    const message = error instanceof Error ? error.message : String(error);
    logger.error({...context, error: message}, 'cli failed');
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
