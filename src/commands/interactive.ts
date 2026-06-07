import { createInterface } from 'node:readline/promises';

/**
 * Interactive prompt builders shared by `kairo run` and `kairo resume`.
 * Both return null when stdin is not a TTY (or the user answers nothing),
 * which the orchestrator treats as "pause here".
 */

export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

export function makeAskUser(): (question: string) => Promise<string | null> {
  return async (question) => {
    if (!isInteractive()) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n[codex] needs your decision:\n  ${question}\n`);
      const answer = await rl.question('> ');
      return answer.trim() || null;
    } finally {
      rl.close();
    }
  };
}

export function makeApprovePlan(): (planPath: string) => Promise<string | null> {
  return async (planPath) => {
    if (!isInteractive()) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n[kairo] the plan requires your approval before implementation.`);
      console.log(`[kairo] plan: ${planPath}`);
      console.log(`[kairo] answer "y" to approve, anything else as feedback for the head agent, or press enter to pause\n`);
      const answer = await rl.question('approve plan? > ');
      return answer.trim() || null;
    } finally {
      rl.close();
    }
  };
}

/** Non-interactive deps for `kairo ask`: never prompt, always pause instead. */
export const neverPrompt = {
  askUser: async (): Promise<string | null> => null,
  approvePlan: async (): Promise<string | null> => null,
};
