import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { createAgentTeam } from '../adapters/team.js';
import { TimelineRenderer } from '../renderers/timeline.js';
import { neverPrompt } from './interactive.js';

/**
 * Stop a task on the user's behalf.
 * Paused tasks finalize immediately (terminal, honest report). Active tasks
 * get a cooperative stop honored at the runner's next safe boundary — Kairo
 * never kills processes it does not own.
 */
export async function stopCommand(repoRoot: string, taskIdPartial: string, reason: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const runner = new ExecaProcessRunner();
  const team = createAgentTeam(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    head: team.head, // never invoked by stop
    developmentLead: team.developmentLead, // never invoked by stop
    runner,
    askUser: neverPrompt.askUser,
    approvePlan: neverPrompt.approvePlan,
    onEvent: (event) => timeline.render(event),
  });

  const outcome = await orchestrator.stop(taskIdPartial, reason);
  if (outcome.outcome === 'stopped_by_user') {
    if (outcome.reportPath) timeline.info(`report saved: ${outcome.reportPath}`);
    timeline.info(`task ${outcome.taskId} stopped`);
    timeline.info(`artifacts: ${join(repoRoot, config.artifactDir, 'tasks', outcome.taskId)}`);
    return;
  }
  // Cooperative path: be honest about what this can and cannot do.
  timeline.info(`stop recorded for ${outcome.taskId} (state: ${outcome.finalState})`);
  timeline.info('an active runner will stop at its next safe boundary; Kairo does not kill running model processes');
  timeline.info('if no runner is alive, the request persists and applies on the next resume');
}
