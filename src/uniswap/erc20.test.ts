import {describe, expect, it, vi} from 'vitest';
import {pino} from 'pino';
import {ensureAllowance, type ApprovalContext} from './erc20.js';

const OWNER = '0xaECac9f39c5808f6A9f0938E644dCbB4db8c6580';
const SPENDER = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function harness(existingAllowance: bigint) {
  const readContract = vi.fn().mockResolvedValue(existingAllowance);
  const simulateContract = vi.fn().mockResolvedValue({request: {}});
  const writeContract = vi.fn().mockResolvedValue('0xapprove');
  const waitForTransactionReceipt = vi
    .fn()
    .mockResolvedValue({status: 'success'});

  const context: ApprovalContext = {
    publicClient: {
      readContract,
      simulateContract,
      waitForTransactionReceipt,
    } as never,
    walletClient: {
      account: {address: OWNER},
      writeContract,
    } as never,
    owner: OWNER,
    spender: SPENDER,
    logger: pino({level: 'silent'}),
  };

  return {context, readContract, simulateContract, writeContract};
}

describe('ensureAllowance', () => {
  it('sends nothing when the allowance already covers the amount', async () => {
    const {context, simulateContract, writeContract} = harness(10_000n);

    const hash = await ensureAllowance(context, TOKEN, 5_000n);

    expect(hash).toBeUndefined();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('approves when the allowance is short', async () => {
    const {context, writeContract} = harness(0n);

    const hash = await ensureAllowance(context, TOKEN, 5_000n);

    expect(hash).toBe('0xapprove');
    expect(writeContract).toHaveBeenCalledOnce();
  });

  it('approves for the max amount, not just what is needed', async () => {
    const {context, simulateContract} = harness(0n);

    await ensureAllowance(context, TOKEN, 5_000n);

    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'approve',
        args: [SPENDER, 2n ** 256n - 1n],
      }),
    );
  });

  it('treats an allowance exactly equal to the amount as sufficient', async () => {
    const {context, writeContract} = harness(5_000n);

    await ensureAllowance(context, TOKEN, 5_000n);

    expect(writeContract).not.toHaveBeenCalled();
  });

  it('waits for the approval to confirm before returning', async () => {
    const {context} = harness(0n);
    let confirmed = false;
    (
      context.publicClient as unknown as {
        waitForTransactionReceipt: ReturnType<typeof vi.fn>;
      }
    ).waitForTransactionReceipt = vi.fn().mockImplementation(async () => {
      confirmed = true;
      return {status: 'success'};
    });

    await ensureAllowance(context, TOKEN, 5_000n);

    expect(confirmed).toBe(true);
  });
});
