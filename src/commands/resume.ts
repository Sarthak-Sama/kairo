import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { CodexCliAdapter } from '../adapters/codex.js';
import { createClaudeAdapter } from '../adapters/claude-factory.js';
import { TimelineRenderer } from '../renderers/timeline.js';
import { makeApprovePlan, makeAskUser } from './interactive.js';

/** Resume a paused task interactively from its persisted pending checkpoint. */
export async function resumeCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const runner = new ExecaProcessRunner();
  const codex = new CodexCliAdapter(runner, config, repoRoot);
  const claude = createClaudeAdapter(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  if (!(await codex.isAvailable())) {
    console.error(
      `[kairo] Codex CLI ("${config.codex.command}") not found on PATH. Install it or set codex.command in .kairo/config.json.`,
    );
    process.exitCode = 1;
    return;
  }

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    codex,
    claude,
    runner,
    askUser: makeAskUser(),
    approvePlan: makeApprovePlan(),
    onEvent: (event) => timeline.render(event),
  });

  const outcome = await orchestrator.resume(taskIdPartial);
  if (outcome.outcome === 'still_paused') {
    timeline.info(`task ${outcome.taskId} remains paused (${outcome.finalState}) — no answer provided`);
    return;
  }
  if (outcome.reportPath) {
    timeline.info(`report saved: ${outcome.reportPath}`);
  }
  timeline.info(`task ${outcome.taskId} finished: ${outcome.outcome}`);
  timeline.info(`artifacts: ${join(repoRoot, config.artifactDir, 'tasks', outcome.taskId)}`);
  if (['failed', 'blocked', 'unsafe'].includes(outcome.outcome)) {
    process.exitCode = 1;
  }
}
