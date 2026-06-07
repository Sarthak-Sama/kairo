import { askAction } from '../core/actions.js';
import { TimelineRenderer } from '../renderers/timeline.js';

/**
 * Provide a user message to a paused task non-interactively.
 * Paused on plan approval: "y"/"yes"/"approve" approves, anything else is
 * plan feedback. Paused on a question: the message is the answer.
 * Not paused: the message is recorded as a note; nothing runs.
 *
 * Audit honesty (user-messages.ndjson) lives in askAction: handled:true only
 * after the pending checkpoint is consumed. Failures BEFORE the task is
 * identified (missing config, unknown id) intentionally record nothing —
 * there is no resolved task directory to write into.
 */
export async function askCommand(repoRoot: string, taskIdPartial: string, message: string): Promise<void> {
  const timeline = new TimelineRenderer();
  const result = await askAction(repoRoot, taskIdPartial, message, {
    onEvent: (event) => timeline.render(event),
  });

  switch (result.status) {
    case 'empty-message':
      console.error('[kairo] message must not be empty');
      process.exitCode = 1;
      return;
    case 'no-pending':
      console.log(
        `[kairo] message recorded, but task ${result.taskId} has no pending decision to resume from (state: ${result.state}). Nothing was run.`,
      );
      return;
    case 'head-missing':
      console.error(
        `[kairo] head agent "${result.provider}" ("${result.command}") not found on PATH. Install it or adjust .kairo/config.json. Message recorded as unhandled.`,
      );
      process.exitCode = 1;
      return;
    case 'refused':
      console.error(`[kairo] error: ${result.error}`);
      process.exitCode = 1;
      return;
    case 'done': {
      const outcome = result.outcome;
      if (outcome.reportPath) timeline.info(`report saved: ${outcome.reportPath}`);
      timeline.info(`task ${outcome.taskId} finished: ${outcome.outcome}`);
      if (['failed', 'blocked', 'unsafe'].includes(outcome.outcome)) {
        process.exitCode = 1;
      }
      return;
    }
  }
}
