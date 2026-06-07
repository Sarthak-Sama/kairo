import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { createAgentTeam } from '../adapters/team.js';
import { TimelineRenderer } from '../renderers/timeline.js';
import { makeApprovePlan, makeAskUser } from './interactive.js';

export async function runCommand(repoRoot: string, taskTitle: string): Promise<void> {
  const config = await loadConfig(repoRoot); // throws with "run kairo init" guidance if missing
  const runner = new ExecaProcessRunner();
  const team = createAgentTeam(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  // The head agent is required up front — every run starts with head triage.
  // The development lead is only required if the run delegates; its
  // availability is checked by the orchestrator at delegation time.
  if (!(await team.head.isAvailable())) {
    console.error(
      `[kairo] head agent "${team.head.provider}" (${config[team.head.provider].command}) not found on PATH. Install it or adjust .kairo/config.json.`,
    );
    process.exitCode = 1;
    return;
  }

  const askUser = makeAskUser();
  const approvePlan = makeApprovePlan();

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    head: team.head,
    developmentLead: team.developmentLead,
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
