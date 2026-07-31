/**
 * Interactive confirmation shared by every fund-moving command.
 *
 * Only the exact word `yes` proceeds; anything else aborts.
 */

import {createInterface} from 'node:readline/promises';

export async function promptYes(summary: string): Promise<boolean> {
  process.stdout.write(summary);
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question("Type 'yes' to continue: ");
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export const alwaysYes = async (): Promise<boolean> => true;

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
