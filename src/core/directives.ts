import { z } from 'zod';

/**
 * The directive protocol: Codex (the agency head) returns one structured
 * directive per turn telling Kairo what to do next. Kairo validates it before
 * acting. Anything that fails validation is saved raw and surfaced to the user.
 */

export const DIRECTIVE_ACTIONS = [
  'ask_user',
  'self_edit',
  'delegate_to_development_lead',
  'request_development_revision',
  'run_checks',
  'review_diff',
  'continue_next_phase',
  'declare_complete',
  'stop_blocked',
  'stop_unsafe',
] as const;

export const DirectiveActionSchema = z.enum(DIRECTIVE_ACTIONS);
export type DirectiveAction = z.infer<typeof DirectiveActionSchema>;

/**
 * Backward compatibility: directives written before the role-neutral protocol
 * (old task.json pending checkpoints, legacy-tuned models) normalize to the
 * canonical form before validation.
 */
const LEGACY_ACTION_MAP: Record<string, DirectiveAction> = {
  delegate_to_claude: 'delegate_to_development_lead',
  request_claude_revision: 'request_development_revision',
};

export function normalizeLegacyDirective(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const obj = { ...(value as Record<string, unknown>) };
  if (obj.actor === 'codex') obj.actor = 'head';
  if (typeof obj.action === 'string' && obj.action in LEGACY_ACTION_MAP) {
    obj.action = LEGACY_ACTION_MAP[obj.action];
  }
  return obj;
}

export const DirectiveSchema = z.preprocess(
  normalizeLegacyDirective,
  z.object({
    actor: z.literal('head'),
    action: DirectiveActionSchema,
  taskClass: z.string().optional(),
  phase: z.number().int().positive().optional(),
  requiresUserInput: z.boolean().default(false),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  reason: z.string().min(1),
  instructions: z.string().optional(),
  question: z.string().optional(),
  successCriteria: z.array(z.string()).default([]),
  checksToRun: z.array(z.string()).default([]),
  }),
);

export type Directive = z.infer<typeof DirectiveSchema>;

export interface DirectiveParseResult {
  ok: boolean;
  directive?: Directive;
  rawOutput: string;
  error?: string;
}

/**
 * Parse a directive out of raw Codex output. Codex is asked to emit a single
 * JSON object; in practice models wrap JSON in prose or code fences, so we
 * extract the most plausible JSON candidate before validating.
 */
export function parseDirective(rawOutput: string): DirectiveParseResult {
  const candidates = extractJsonCandidates(rawOutput);
  if (candidates.length === 0) {
    return { ok: false, rawOutput, error: 'No JSON object found in Codex output' };
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      errors.push(`invalid JSON: ${(err as Error).message}`);
      continue;
    }
    const result = DirectiveSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, directive: result.data, rawOutput };
    }
    errors.push(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return {
    ok: false,
    rawOutput,
    error: `JSON found but no candidate matched the directive schema. Issues: ${errors.join(' | ')}`,
  };
}

/** Extract candidate JSON objects: fenced ```json blocks first, then bare top-level objects. */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body && body.startsWith('{')) candidates.push(body);
  }
  // Bare object scan: find balanced top-level {...} spans.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return candidates;
}
