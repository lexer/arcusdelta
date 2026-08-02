# 0006 — Full cycle script

Status: implemented

## Context

Running the strategy end to end currently needs three separate commands typed in sequence: `npm run buy` (which itself chains buy + deposit), then `npm run monitor` run separately afterward. The user asked for one script that buys, opens the position, and stays running until the position's own exit condition fires — no separate manual step to start monitoring.

## Decision

`npm run cycle` is pure orchestration of three pieces that already exist, are tested, and have each been run live independently: `runBuyCommand`, `runDepositCommand`, `PositionMonitor.run`. No new fund-moving logic is introduced — this only sequences existing ones.

- **Two confirmations, then unattended.** Buy and deposit each confirm exactly as `npm run buy` already does (`--yes` skips both). Once deposited, monitoring runs exactly as `npm run monitor` already does — unattended, no further prompts — because that is already how the operator chose monitor to behave (plan 0003). The cycle script does not change that decision; it just removes the manual step of starting it.
- **Targets the exact position just minted**, not pool-wide discovery. `DepositResult.tokenId` (read from the mint's `IncreaseLiquidity` event, per plan 0005) is passed to `monitor.run({tokenId})`. This matters because the wallet has held unrelated position NFTs before; discovery-by-pool would be correct today but targeting the specific tokenId removes any dependence on that happening to still be true.
- **Falls back to pool-wide discovery with a warning** if the tokenId could not be read from the mint receipt (should not happen on a successful mint, but the extraction already returns `undefined` on failure elsewhere in the codebase, so the caller here handles that case rather than assuming it can't occur).
- **One cycle, not a loop.** The script ends once the position closes. Re-entering the strategy after exit (buying and depositing again at the new price) is a separate future feature, already noted as unbuilt in `docs/architecture.md`, and is a materially different risk profile (unattended repeated spending) that deserves its own explicit decision rather than being folded in silently.
- **No new termination condition.** "Termination condition" is the one `PositionMonitor` already implements: the pool reading out-of-range for `EXIT_CONFIRMATIONS` consecutive polls.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` green.
- Not run live by the agent — it starts with the same two fund-moving confirmations `npm run buy` already has, and then runs unattended for an unbounded period. The operator runs it.
