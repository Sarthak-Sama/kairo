import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { CodexCliAdapter } from '../adapters/codex.js';
import { ClaudeCliAdapter } from '../adapters/claude.js';
import { TimelineRenderer } from '../renderers/timeline.js';

export async function runCommand(repoRoot: string, taskTitle: string): Promise<void> {
  const config = await loadConfig(repoRoot); // throws with "run kairo init" guidance if missing
  const runner = new ExecaProcessRunner();
  const codex = new CodexCliAdapter(runner, config, repoRoot);
  const claude = new ClaudeCliAdapter(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  // Codex is required up front — every run starts with Codex triage. Claude
  // is only required if the run actually delegates implementation, so its
  // availability is checked by the orchestrator at delegation time.
  if (!(await codex.isAvailable())) {
    console.error(
      `[kairo] Codex CLI ("${config.codex.command}") not found on PATH. Install it or set codex.command in .kairo/config.json.`,
    );
    process.exitCode = 1;
    return;
  }

  const interactive = process.stdin.isTTY === true;
  const askUser = async (question: string): Promise<string | null> => {
    if (!interactive) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n[codex] needs your decision:\n  ${question}\n`);
      const answer = await rl.question('> ');
      return answer.trim() || null;
    } finally {
      rl.close();
    }
  };

  const approvePlan = async (planPath: string): Promise<string | null> => {
    if (!interactive) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n[kairo] the plan requires your approval before implementation.`);
      console.log(`[kairo] plan: ${planPath}`);
      console.log(`[kairo] answer "y" to approve, anything else as feedback for codex, or press enter to pause\n`);
      const answer = await rl.question('approve plan? > ');
      return answer.trim() || null;
    } finally {
      rl.close();
    }
  };

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    codex,
    claude,
    runner,
    askUser,
    approvePlan,
    onEvent: (event) => timeline.render(event),
  });

  const outcome = await orchestrator.run(taskTitle);
  if (outcome.reportPath) {
    timeline.info(`report saved: ${outcome.reportPath}`);
  }
  timeline.info(`task ${outcome.taskId} finished: ${outcome.outcome}`);
  timeline.info(`artifacts: ${join(repoRoot, config.artifactDir, 'tasks', outcome.taskId)}`);
  if (['failed', 'blocked', 'unsafe'].includes(outcome.outcome)) {
    process.exitCode = 1;
  }
}
