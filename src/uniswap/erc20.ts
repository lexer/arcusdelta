/**
 * Plain ERC20 approval for the v3 NonfungiblePositionManager.
 *
 * v3's `mint()` pulls funds via a direct `transferFrom`, so a single
 * `approve(spender, amount)` is sufficient — unlike v4, which routed through
 * Permit2 and needed a two-step allowance (token -> Permit2 -> spender).
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

const MAX_UINT256 = 2n ** 256n - 1n;

export interface ApprovalContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly owner: Hex;
  readonly spender: Hex;
  readonly logger: Logger;
}

/**
 * Ensures the allowance covers `amount`, sending an approval only when the
 * existing one is genuinely short. Returns the transaction hash if one was
 * sent.
 */
export async function ensureAllowance(
  context: ApprovalContext,
  token: Hex,
  amount: bigint,
): Promise<Hex | undefined> {
  const {publicClient, walletClient, owner, spender, logger} = context;
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
  logger.info(
    {
      token,
      spender,
      allowance: allowance.toString(),
      amount: amount.toString(),
    },
    'checked erc20 allowance',
  );

  if (allowance >= amount) return undefined;

  const {request} = await publicClient.simulateContract({
    account,
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
  });
  const hash = await walletClient.writeContract(request);
  logger.info({token, spender, hash}, 'approved spender on token');
  await publicClient.waitForTransactionReceipt({hash});
  return hash;
}
