import type { Task } from './task-store.js';
import type { AgencyEvent } from './events.js';
import type { CheckResult } from './checks.js';

export type CommitRecommendation =
  | 'safe to commit'
  | 'needs manual review'
  | 'not safe to commit';

export interface ReportInput {
  task: Task;
  events: AgencyEvent[];
  changedFiles: string[];
  commandsRun: string[];
  checkResults: CheckResult[];
  codexReview: string;
  /** Risk lines; prefix with "high:" or "medium:" to drive the recommendation. */
  risks: string[];
  /** True when diff capture was unavailable for any implementation phase. */
  diffUnavailable?: boolean;
  /** Configured checks that never ran in any phase — listed, never implied passed. */
  unrunCheckNames?: string[];
  /** One-line description of the git baseline (cleanliness, sha). */
  baselineNote?: string;
  scope: string;
  summary: string;
  followUp: string[];
}

/**
 * Commit recommendation rules:
 * - not safe to commit: failed/blocked/unsafe/interrupted outcome, failed or
 *   blocked checks, diff unavailable after implementation, any high-risk flag,
 *   or review blockers
 * - needs manual review: skipped checks, no checks at all, medium-risk
 *   warnings, or any non-completed outcome
 * - safe to commit: only a completed outcome with diff available, checks
 *   passed, no blockers, no risk flags
 */
export function decideCommitRecommendation(input: {
  outcome: string;
  checkResults: CheckResult[];
  reviewHasBlockers: boolean;
  highRisk: boolean;
  mediumRisk: boolean;
  diffUnavailable: boolean;
}): CommitRecommendation {
  const failed = input.checkResults.some((r) => r.status === 'failed' || r.status === 'blocked');
  const skipped = input.checkResults.some((r) => r.status === 'skipped');
  const badOutcome = ['failed', 'blocked', 'unsafe', 'interrupted'].includes(input.outcome);

  if (failed || badOutcome || input.highRisk || input.reviewHasBlockers || input.diffUnavailable) {
    return 'not safe to commit';
  }
  if (
    skipped ||
    input.checkResults.length === 0 ||
    input.mediumRisk ||
    input.outcome !== 'completed'
  ) {
    return 'needs manual review';
  }
  return 'safe to commit';
}

/** Detect blocker mentions while ignoring negations like "no blockers". */
export function reviewMentionsBlockers(review: string): boolean {
  const negationsStripped = review.replace(/\b(?:no|zero|without|free of)\s+(?:known\s+)?blockers?\b/gi, '');
  return /\bblockers?\b/i.test(negationsStripped);
}

export function generateReport(input: ReportInput): string {
  const outcome = input.task.outcome ?? input.task.state;
  const recommendation = decideCommitRecommendation({
    outcome,
    checkResults: input.checkResults,
    reviewHasBlockers: reviewMentionsBlockers(input.codexReview),
    highRisk: input.risks.some((r) => /^high\b/i.test(r)),
    mediumRisk: input.risks.some((r) => /^medium\b/i.test(r)),
    diffUnavailable: input.diffUnavailable ?? false,
  });

  const lines: string[] = [];
  lines.push(`# Task Report: ${input.task.title}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(input.summary || '(no summary recorded)');
  lines.push('');
  lines.push('## Outcome');
  lines.push('');
  lines.push(outcome);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(input.scope || '(no scope recorded)');
  lines.push('');
  lines.push('## Agency Timeline');
  lines.push('');
  if (input.events.length === 0) {
    lines.push('(no events recorded)');
  } else {
    for (const e of input.events) {
      lines.push(`- \`${e.timestamp}\` **[${e.actor}]** ${e.action} (${e.status}) — ${e.message}`);
    }
  }
  lines.push('');
  lines.push('## Files Changed');
  lines.push('');
  if (input.changedFiles.length === 0) {
    lines.push('(none detected)');
  } else {
    for (const f of input.changedFiles) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('## Commands Run');
  lines.push('');
  if (input.commandsRun.length === 0) {
    lines.push('(none recorded)');
  } else {
    for (const c of input.commandsRun) lines.push(`- \`${c}\``);
  }
  lines.push('');
  lines.push('## Verification');
  lines.push('');
  if (input.baselineNote) {
    lines.push(`- **baseline**: ${input.baselineNote}`);
  }
  if (input.diffUnavailable) {
    lines.push('- **diff**: capture was UNAVAILABLE — changed-file evidence relies on agent self-reports only');
  }
  if (input.checkResults.length === 0 && (input.unrunCheckNames ?? []).length === 0) {
    lines.push('No checks were run.');
  } else {
    for (const r of input.checkResults) {
      lines.push(`- **${r.name}** (\`${r.command}\`): ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    for (const name of input.unrunCheckNames ?? []) {
      lines.push(`- **${name}**: NOT RUN — configured but never executed for this task`);
    }
  }
  lines.push('');
  lines.push('## Codex Review');
  lines.push('');
  lines.push(input.codexReview || '(no review recorded)');
  lines.push('');
  lines.push('## Risks');
  lines.push('');
  if (input.risks.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const r of input.risks) lines.push(`- ${r}`);
  }
  lines.push('');
  lines.push('## Follow-up');
  lines.push('');
  if (input.followUp.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const f of input.followUp) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('## Commit Recommendation');
  lines.push('');
  lines.push(`**${recommendation}**`);
  lines.push('');
  return lines.join('\n');
}
