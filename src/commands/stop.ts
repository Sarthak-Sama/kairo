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
  // Active task: the signal is written; an active transport will terminate
  // its owned child at the next cancellation poll. Never claim "stopped"
  // until the orchestrator actually observes it.
  timeline.info(`stop requested for ${outcome.taskId}; active process will be cancelled at the next transport check`);
  timeline.info('Kairo only terminates child processes it owns — never by name, never globally');
  timeline.info('if no runner is alive, the request persists and applies on the next resume');
}
