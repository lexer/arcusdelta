/**
 * Two-step token authorization required by Uniswap v4 periphery.
 *
 * PositionManager pulls funds through Permit2, so each token needs:
 *   1. an ERC-20 allowance from the wallet to Permit2, and
 *   2. a Permit2 allowance from the wallet to PositionManager.
 *
 * Both are checked before being sent — an approval transaction is only
 * broadcast when the existing allowance is genuinely insufficient.
 */

import type {Hex, PublicClient, WalletClient} from 'viem';
import type {Logger} from '../logging/logger.js';

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint8'}],
  },
] as const;

export const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'token', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [
      {name: 'amount', type: 'uint160'},
      {name: 'expiration', type: 'uint48'},
      {name: 'nonce', type: 'uint48'},
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'token', type: 'address'},
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint160'},
      {name: 'expiration', type: 'uint48'},
    ],
    outputs: [],
  },
] as const;

const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT160 = 2n ** 160n - 1n;
/** Permit2 treats an expiration of 0 as "expires at the end of this block". */
const PERMIT2_MAX_EXPIRATION = 2n ** 48n - 1n;

export interface ApprovalContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly owner: Hex;
  readonly permit2: Hex;
  readonly spender: Hex;
  readonly logger: Logger;
}

/**
 * Ensures both allowances cover `amount`, sending approvals only where short.
 * Returns the hashes of any transactions actually broadcast.
 */
export async function ensureAllowances(
  context: ApprovalContext,
  token: Hex,
  amount: bigint,
): Promise<Hex[]> {
  const {publicClient, walletClient, owner, permit2, spender, logger} = context;
  const sent: Hex[] = [];
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const erc20Allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, permit2],
  });
  logger.info(
    {
      token,
      spender: permit2,
      allowance: erc20Allowance.toString(),
      amount: amount.toString(),
    },
    'checked erc20 allowance to permit2',
  );

  if (erc20Allowance < amount) {
    const {request} = await publicClient.simulateContract({
      account,
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [permit2, MAX_UINT256],
    });
    const hash = await walletClient.writeContract(request);
    logger.info({token, hash}, 'approved permit2 on token');
    await publicClient.waitForTransactionReceipt({hash});
    sent.push(hash);
  }

  const [permit2Amount, expiration] = await publicClient.readContract({
    address: permit2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [owner, token, spender],
  });
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const permit2Sufficient =
    BigInt(permit2Amount) >= amount && BigInt(expiration) > nowSeconds;
  logger.info(
    {
      token,
      spender,
      allowance: permit2Amount.toString(),
      expiration: expiration.toString(),
      sufficient: permit2Sufficient,
    },
    'checked permit2 allowance to position manager',
  );

  if (!permit2Sufficient) {
    const {request} = await publicClient.simulateContract({
      account,
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, spender, MAX_UINT160, Number(PERMIT2_MAX_EXPIRATION)],
    });
    const hash = await walletClient.writeContract(request);
    logger.info({token, spender, hash}, 'approved position manager on permit2');
    await publicClient.waitForTransactionReceipt({hash});
    sent.push(hash);
  }

  return sent;
}
