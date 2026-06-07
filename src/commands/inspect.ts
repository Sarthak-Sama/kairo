import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';
import { readEventLog } from '../core/events.js';
import { formatEventLine } from '../renderers/timeline.js';
import { fileExists, readJson, readText } from '../utils/fs.js';

export async function inspectCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);
  const taskDir = store.taskDir(taskId);

  console.log(`[kairo] task ${task.id}`);
  console.log(`  title:       ${task.title}`);
  console.log(`  state:       ${task.state}`);
  console.log(`  outcome:     ${task.outcome ?? '-'}`);
  console.log(`  created:     ${task.createdAt}`);
  console.log(`  updated:     ${task.updatedAt}`);
  console.log(`  phase:       ${task.currentPhase}`);
  console.log(`  model calls: ${task.modelCalls}`);
  console.log(`  profile:     ${task.profile ?? 'none'}`);
  console.log(
    `  team:        ${task.team ? `head=${task.team.head} development=${task.team.developmentLead}` : '(not recorded — legacy task)'}`,
  );
  if (task.baseline) {
    console.log(
      `  baseline:    ${task.baseline.isGitRepo ? `${task.baseline.branch}@${task.baseline.headSha?.slice(0, 8)}${task.baseline.dirty ? ' (dirty)' : ''}` : 'not a git repo'}`,
    );
  }
  // Stopped tasks must be unmistakable.
  const stopPath = join(taskDir, 'stop-requested.json');
  if (await fileExists(stopPath)) {
    try {
      const stop = await readJson<{ reason?: string; requestedAt?: string }>(stopPath);
      const honored = task.outcome === 'stopped_by_user';
      console.log('\n  stop:');
      console.log(`    ${honored ? 'STOPPED BY USER' : 'STOP REQUESTED (not yet honored — runner stops at next safe boundary)'}`);
      console.log(`    reason: ${stop.reason ?? '(none given)'}`);
      if (stop.requestedAt) console.log(`    at:     ${stop.requestedAt}`);
    } catch {
      console.log('\n  stop: requested (stop-requested.json unreadable)');
    }
  }

  // Latest manager notes (supervision context, not answers).
  const notesPath = join(taskDir, 'manager-notes.md');
  if (await fileExists(notesPath)) {
    const noteBlocks = (await readText(notesPath)).split(/^## /m).filter((b) => b.trim());
    const latest = noteBlocks.slice(-3);
    console.log(`\n  manager notes (last ${latest.length} of ${noteBlocks.length}):`);
    for (const block of latest) {
      const [stamp, ...body] = block.trim().split('\n');
      console.log(`    ${stamp}  ${body.join(' ').trim().slice(0, 120)}`);
    }
  }

  if (task.pending) {
    console.log('\n  pending:');
    console.log(`    kind:      ${task.pending.kind}`);
    if (task.pending.kind === 'plan_approval') {
      console.log(`    plan:      ${task.pending.planPath}`);
    } else {
      console.log(`    question:  ${task.pending.question}`);
    }
    console.log(`    directive: ${task.pending.directive.action} (risk ${task.pending.directive.risk})`);
    console.log(`    since:     ${task.pending.createdAt}`);
    console.log(`    continue:  kairo resume ${task.id}  |  kairo ask ${task.id} "<answer>"`);
  }
  console.log('\n  state history:');
  for (const entry of task.stateHistory) {
    console.log(`    ${entry.at}  ${entry.state}`);
  }

  // Latest activity: what the agency did most recently.
  const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
  if (events.length > 0) {
    console.log(`\n  recent events (last ${Math.min(10, events.length)} of ${events.length}):`);
    for (const event of events.slice(-10)) {
      console.log('    ' + formatEventLine(event));
    }
  }

  // Quick paths: where to look right now.
  const keyPaths: Array<[string, string]> = [];
  const reportPath = join(taskDir, 'report.md');
  if (await fileExists(reportPath)) keyPaths.push(['report', reportPath]);
  const phase = Math.max(task.currentPhase, 1);
  const transcriptPath = join(store.phaseDir(taskId, phase), 'claude-transcript.log');
  if (await fileExists(transcriptPath)) keyPaths.push(['claude transcript', transcriptPath]);
  const planPath = join(taskDir, 'master-plan.md');
  if (await fileExists(planPath)) keyPaths.push(['master plan', planPath]);
  if (keyPaths.length > 0) {
    console.log('\n  key artifacts:');
    for (const [label, path] of keyPaths) {
      console.log(`    ${label.padEnd(18)} ${path}`);
    }
  }

  console.log('\n  artifacts:');
  await printTree(taskDir, taskDir, '    ');
}

async function printTree(root: string, dir: string, indent: string): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${indent}${relative(root, full)}/`);
      await printTree(root, full, indent);
    } else {
      const size = (await stat(full)).size;
      console.log(`${indent}${relative(root, full)} (${formatSize(size)})`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
