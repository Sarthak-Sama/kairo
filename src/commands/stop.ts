import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { stopAction } from '../core/actions.js';
import { TimelineRenderer } from '../renderers/timeline.js';

/**
 * Stop a task on the user's behalf.
 * Paused tasks finalize immediately (terminal, honest report). Active tasks
 * get the control.json signal: owned child processes are cancelled at the
 * next transport poll — Kairo never kills processes it does not own.
 */
export async function stopCommand(repoRoot: string, taskIdPartial: string, reason: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const timeline = new TimelineRenderer();
  const outcome = await stopAction(repoRoot, taskIdPartial, reason, {
    onEvent: (event) => timeline.render(event),
  });

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
