import { DIRECTIVE_ACTIONS } from './directives.js';
import type { ChecksRun } from './checks.js';
import type { KairoConfig } from './config.js';

/**
 * Prompt builders for both agents. Context is reconstructed from artifacts on
 * every call instead of relying on CLI session resume — see docs/architecture.md.
 */

const DIRECTIVE_CONTRACT = `
You MUST end your reply with exactly one JSON object (a "directive") inside a \`\`\`json code fence.
The directive schema:
{
  "actor": "codex",
  "action": one of ${JSON.stringify([...DIRECTIVE_ACTIONS])},
  "taskClass": string (optional, e.g. "quick_self_edit" | "single_phase_claude" | "multi_phase"),
  "phase": positive integer (optional),
  "requiresUserInput": boolean,
  "risk": "low" | "medium" | "high",
  "reason": string (required — why this action),
  "instructions": string (optional — implementation instructions when delegating or self-editing),
  "question": string (optional — required when action is "ask_user"),
  "successCriteria": string[] (optional),
  "checksToRun": string[] (optional — names of configured checks)
}

Rules:
- "instructions" is REQUIRED for "self_edit", "delegate_to_claude", "request_claude_revision", and "continue_next_phase" — it must contain the complete, self-sufficient instructions for that edit/phase/revision. Kairo refuses these actions without instructions.
- "checksToRun" entries must be NAMES from the configured checks list, exactly as listed — never shell commands. Unknown names cause ALL configured checks to run instead.
- "ask_user" is ONLY for product/business/tradeoff/dangerous decisions, never for code-quality questions you can decide yourself.
- "self_edit" only when delegation would clearly waste tokens (tiny scoped change); say so in "reason". Choosing self_edit does NOT mean edit now — Kairo will invoke you again in a separate write-enabled self-edit session. Put the complete edit instructions in "instructions".
- Never instruct anyone to commit. Kairo never auto-commits.
- If the task is unsafe or out of scope, use "stop_unsafe" or "stop_blocked" with a clear reason.
`.trim();

export function buildTriagePrompt(input: {
  taskTitle: string;
  repoScanMarkdown: string;
  config: KairoConfig;
}): string {
  const checkNames = input.config.checks.map((c) => c.name).join(', ') || '(none configured)';
  return `You are the agency head for a local coding task runtime called Kairo.
Your role: inspect the repository, classify the task, and produce a plan plus a directive.
This is a READ-ONLY planning session: you may read files and run non-destructive commands to inspect the repo, but you must not modify anything. If you decide on "self_edit", Kairo will invoke you again in a separate write-enabled session to perform the edits.

## Task from user
${input.taskTitle}

## Repo scan (pre-computed by Kairo)
${input.repoScanMarkdown}

## Configured checks
${checkNames}

## What to do
1. Inspect the repo as needed to understand the task's scope.
2. Classify the task: quick_self_edit (trivial, you do it), single_phase_claude (one implementation phase by Claude Code), or multi_phase.
3. Write a concise master plan in markdown (before your directive): scope, approach, phases if multi-phase, risks.
4. Decide the first action: "self_edit" (Kairo will call you again in a write-enabled self-edit session — put the full edit instructions in "instructions"), "delegate_to_claude" (with full implementation instructions for phase 1), "ask_user" (only if a real product/tradeoff decision is needed first), or "stop_blocked"/"stop_unsafe".

${DIRECTIVE_CONTRACT}`;
}

export function buildReviewPrompt(input: {
  taskTitle: string;
  phase: number;
  masterPlan: string;
  claudeReport: string;
  diffPatch: string;
  checksRun: ChecksRun | null;
  revisionCount: number;
  maxRevisions: number;
  configuredCheckNames: string[];
}): string {
  const checksSummary = input.checksRun
    ? input.checksRun.results
        .map((r) => `- ${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`)
        .join('\n')
    : '(checks not run)';
  const diff = truncate(input.diffPatch, 60000) || '(no diff captured)';
  return `You are the agency head reviewing an implementation phase for the task below.

## Task
${input.taskTitle}

## Phase under review
Phase ${input.phase} (revision ${input.revisionCount} of max ${input.maxRevisions})

## Master plan
${input.masterPlan || '(no master plan recorded)'}

## Implementer report (Claude Code)
${input.claudeReport || '(no report)'}

## Check results
${checksSummary}

## Configured checks (use these exact names in "checksToRun")
${input.configuredCheckNames.join(', ') || '(none configured)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

## What to do
Review the diff against the plan and success criteria. Then choose exactly one action:
- "request_claude_revision" — for code-quality issues, bugs, failed checks, or scope drift. Put concrete revision instructions in "instructions".
- "ask_user" — ONLY if a product/business/tradeoff decision emerged.
- "continue_next_phase" — phase is good and more phases remain in the plan.
- "declare_complete" — the whole task is done and verified.
- "stop_blocked" / "stop_unsafe" — if continuing is impossible or unsafe.

${DIRECTIVE_CONTRACT}`;
}

export function buildClaudePrompt(input: {
  taskTitle: string;
  phase: number;
  instructions: string;
  successCriteria: string[];
  masterPlan: string;
  isRevision: boolean;
  previousReport?: string;
}): string {
  const criteria =
    input.successCriteria.length > 0
      ? input.successCriteria.map((c) => `- ${c}`).join('\n')
      : '(none specified — use your judgment against the plan)';
  const revisionBlock = input.isRevision
    ? `\n## This is a REVISION request\nYour previous report:\n${input.previousReport ?? '(unavailable)'}\n\nAddress the revision instructions below. Do not redo work that was accepted.\n`
    : '';
  return `You are the implementation lead for one phase of a coding task, working under an external reviewer.

## Task
${input.taskTitle}

## Master plan (from the reviewer)
${input.masterPlan || '(no plan — single phase task)'}
${revisionBlock}
## Phase ${input.phase} instructions
${input.instructions}

## Success criteria
${criteria}

## Hard rules
- Implement ONLY this phase. No unrelated refactors, no drive-by cleanups.
- Do NOT commit. Do not run git commit, push, reset, or clean.
- You may use your own subagents if useful.

## Required report
End your reply with a markdown report in exactly this structure:

# Phase ${input.phase} Report
## Changed Files
(list every file you created/modified/deleted)
## Commands Run
(list shell commands you ran)
## Risks
(known risks, shortcuts, or follow-ups; "none" if none)
## Phase Complete
yes / no — with one line of justification`;
}

export function buildSelfEditPrompt(input: {
  taskTitle: string;
  phase: number;
  instructions: string;
  masterPlan: string;
}): string {
  return `You are the agency head for Kairo, now in a WRITE-ENABLED self-edit session.
During planning you decided this change is small enough to make yourself. Make exactly those edits now.

## Task
${input.taskTitle}

## Your plan
${input.masterPlan || '(no plan prose recorded)'}

## Edit instructions (from your own triage directive)
${input.instructions}

## Hard rules
- Make ONLY the edits described above. No unrelated changes.
- Do NOT commit. Do not run git commit, push, reset, or clean.

## Required final message
End with a short markdown summary: what you changed, which files, and any caveats. Kairo captures the working-tree diff separately and will have your edits reviewed.`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n… (diff truncated for review)';
}
