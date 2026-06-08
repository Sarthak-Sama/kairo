import { z } from 'zod';

/**
 * Built-in quality lanes (v0, hardcoded by design — NOT a configurable policy
 * engine). A lane shapes planning, approval, prompts, review focus, the
 * lane-required checks, and report risk. One lane per task.
 */
export const QUALITY_LANES = ['copy', 'bugfix', 'feature', 'refactor', 'risky'] as const;
export const QualityLaneSchema = z.enum(QUALITY_LANES);
export type QualityLane = z.infer<typeof QualityLaneSchema>;

/** How the lane was decided — for honest reporting. */
export type LaneSource = 'user-selected' | 'head-classified' | 'inferred';

export interface LaneDefinition {
  lane: QualityLane;
  /** One-line description for the triage lane menu. */
  summary: string;
  /** Engineering-standards rubric injected into prompts. */
  rubric: string;
  /** What the reviewer should focus on for this lane. */
  reviewFocus: string;
  /** Configured-check names this lane expects to have run. */
  requiredChecks: string[];
  /** "always" → implementation always needs approval; "delegation" → only
   *  for delegation/multi-file/medium+ risk; "quick-bypass" → tiny low-risk
   *  quick self-edits may bypass. */
  approval: 'always' | 'delegation' | 'quick-bypass';
  /** Risk level for unrun required checks. */
  unrunCheckRisk: 'medium' | 'high';
}

export const LANE_DEFINITIONS: Record<QualityLane, LaneDefinition> = {
  copy: {
    lane: 'copy',
    summary: 'content/copy-only changes (wording, text, microcopy)',
    rubric:
      'Copy lane: change ONLY text/content. Do NOT add routes, components, files, or new behavior unless the task explicitly requests it. Keep edits surgical and reversible.',
    reviewFocus: 'scope control — verify no accidental product/UX expansion, only copy/content changed.',
    requiredChecks: ['typecheck', 'lint'],
    approval: 'quick-bypass',
    unrunCheckRisk: 'medium',
  },
  bugfix: {
    lane: 'bugfix',
    summary: 'broken behavior or failing tests',
    rubric:
      'Bugfix lane: explain the bug cause or reproduction before fixing. Fix the root cause, do not mask it. Add or update a test that would catch this bug when practical.',
    reviewFocus: 'verify the bug is genuinely fixed (not masked), and no regression risk is introduced.',
    requiredChecks: ['typecheck', 'test'],
    approval: 'delegation',
    unrunCheckRisk: 'medium',
  },
  feature: {
    lane: 'feature',
    summary: 'new user-facing functionality',
    rubric:
      'Feature lane: cover UX, edge cases, tests, and explicit scope boundaries. State what is in and out of scope. Add tests for new behavior.',
    reviewFocus: 'UX correctness, scope control, edge cases, and test coverage of the new behavior.',
    requiredChecks: ['typecheck', 'lint', 'test', 'build'],
    approval: 'always',
    unrunCheckRisk: 'high',
  },
  refactor: {
    lane: 'refactor',
    summary: 'internal restructuring with no intended behavior change',
    rubric:
      'Refactor lane: preserve behavior exactly. No product/UX/API changes. Keep the change set as narrow as the restructuring requires.',
    reviewFocus: 'behavior preservation, breadth of changed files, and any accidental API/UI changes.',
    requiredChecks: ['typecheck', 'lint', 'test', 'build'],
    approval: 'always',
    unrunCheckRisk: 'high',
  },
  risky: {
    lane: 'risky',
    summary: 'auth, payments, data migrations, permissions, security, secrets/env, production data, or irreversible operations',
    rubric:
      'Risky lane: this touches auth/payments/migrations/permissions/security/secrets/production data or irreversible operations. Ask the user about any business or security ambiguity. Prefer stop_blocked/stop_unsafe/ask_user over guessing.',
    reviewFocus: 'strictest mode — security/correctness; flag high risk unless verification is strong and complete.',
    requiredChecks: ['typecheck', 'lint', 'test', 'build'],
    approval: 'always',
    unrunCheckRisk: 'high',
  },
};

export function laneDefinition(lane: QualityLane): LaneDefinition {
  return LANE_DEFINITIONS[lane];
}

/** Lane menu for the triage prompt (head must pick one). */
export function laneMenuMarkdown(): string {
  return QUALITY_LANES.map((l) => `- "${l}": ${LANE_DEFINITIONS[l].summary}`).join('\n');
}

const RISKY_SIGNALS =
  /\b(auth|authentication|login|password|payment|billing|stripe|checkout|migration|migrate|permission|security|secret|credential|token|\.env\b|production data|delete|drop table|irreversible|destructive)\w*/i;
const FEATURE_TEXT = /\b(add|build|create|implement|new)\b/i;
const REFACTOR_TEXT = /\b(refactor|restructure|rename|reorganize|extract|clean ?up|consolidate)\w*/i;
const BUGFIX_TEXT = /\b(fix|bug|broken|failing|regression|crash|error|incorrect)\w*/i;
const COPY_TEXT = /\b(copy|wording|text|microcopy|label|caption|message|typo|comment)\w*/i;

/**
 * Conservative fallback classifier when neither the operator nor the head
 * named a lane. Order matters: safety-leaning (risky) wins, then the most
 * specific intent. Defaults to `feature` (stricter) over `copy` when unsure.
 */
export function inferLane(input: {
  taskClass?: string;
  risk?: 'low' | 'medium' | 'high';
  action?: string;
  text: string;
}): QualityLane {
  const text = `${input.taskClass ?? ''} ${input.text}`;
  if (RISKY_SIGNALS.test(text) || input.risk === 'high') return 'risky';
  if (REFACTOR_TEXT.test(text)) return 'refactor';
  if (BUGFIX_TEXT.test(text)) return 'bugfix';
  if (COPY_TEXT.test(text) && !FEATURE_TEXT.test(text)) return 'copy';
  if (FEATURE_TEXT.test(text)) return 'feature';
  return 'feature'; // stricter default when genuinely ambiguous
}
