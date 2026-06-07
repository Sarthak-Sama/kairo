import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { createAgentTeam } from '../adapters/team.js';
import { TimelineRenderer } from '../renderers/timeline.js';
import { makeApprovePlan, makeAskUser } from './interactive.js';

/** Resume a paused task interactively from its persisted pending checkpoint. */
export async function resumeCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const runner = new ExecaProcessRunner();
  const team = createAgentTeam(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  if (!(await team.head.isAvailable())) {
    console.error(
      `[kairo] head agent "${team.head.provider}" (${config[team.head.provider].command}) not found on PATH. Install it or adjust .kairo/config.json.`,
    );
    process.exitCode = 1;
    return;
  }

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    head: team.head,
    developmentLead: team.developmentLead,
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
