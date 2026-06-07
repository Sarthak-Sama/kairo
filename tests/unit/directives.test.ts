import { describe, it, expect } from 'vitest';
import { DirectiveSchema, parseDirective } from '../../src/core/directives.js';

const validDirective = {
  actor: 'codex',
  action: 'delegate_to_claude',
  taskClass: 'single_phase_claude',
  phase: 1,
  requiresUserInput: false,
  risk: 'medium',
  reason: 'Feature touches multiple UI files.',
  instructions: 'Build phase 1 only...',
  successCriteria: ['Shortcut opens modal'],
  checksToRun: ['typecheck', 'test'],
};

describe('directive schema', () => {
  it('accepts a complete legacy directive and normalizes it to role-neutral form', () => {
    const parsed = DirectiveSchema.parse(validDirective);
    expect(parsed.action).toBe('delegate_to_development_lead'); // delegate_to_claude normalized
    expect(parsed.actor).toBe('head'); // codex normalized
  });

  it('accepts the canonical role-neutral form directly', () => {
    const parsed = DirectiveSchema.parse({
      ...validDirective,
      actor: 'head',
      action: 'delegate_to_development_lead',
    });
    expect(parsed.action).toBe('delegate_to_development_lead');
    expect(parsed.actor).toBe('head');
  });

  it('normalizes legacy request_claude_revision', () => {
    const parsed = DirectiveSchema.parse({
      ...validDirective,
      actor: 'head',
      action: 'request_claude_revision',
    });
    expect(parsed.action).toBe('request_development_revision');
  });

  it('rejects unknown actions', () => {
    const result = DirectiveSchema.safeParse({ ...validDirective, action: 'do_magic' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown actors (only head/legacy codex accepted)', () => {
    const result = DirectiveSchema.safeParse({ ...validDirective, actor: 'claude' });
    expect(result.success).toBe(false);
  });

  it('requires a reason', () => {
    const rest: Record<string, unknown> = { ...validDirective };
    delete rest.reason;
    expect(DirectiveSchema.safeParse(rest).success).toBe(false);
  });

  it('defaults requiresUserInput, risk, successCriteria, checksToRun', () => {
    const parsed = DirectiveSchema.parse({
      actor: 'codex',
      action: 'declare_complete',
      reason: 'done',
    });
    expect(parsed.requiresUserInput).toBe(false);
    expect(parsed.risk).toBe('medium');
    expect(parsed.successCriteria).toEqual([]);
    expect(parsed.checksToRun).toEqual([]);
  });
});

describe('parseDirective', () => {
  it('parses a directive from a json code fence', () => {
    const text = `Here is my plan.\n\n\`\`\`json\n${JSON.stringify(validDirective)}\n\`\`\``;
    const result = parseDirective(text);
    expect(result.ok).toBe(true);
    expect(result.directive?.action).toBe('delegate_to_development_lead');
  });

  it('parses a bare JSON object without fences', () => {
    const result = parseDirective(JSON.stringify(validDirective));
    expect(result.ok).toBe(true);
  });

  it('parses JSON embedded in surrounding prose', () => {
    const text = `I inspected the repo.\n${JSON.stringify(validDirective)}\nThat is my decision.`;
    const result = parseDirective(text);
    expect(result.ok).toBe(true);
  });

  it('handles braces inside JSON strings', () => {
    const directive = { ...validDirective, instructions: 'Use `if (x) { y() }` style' };
    const result = parseDirective(JSON.stringify(directive));
    expect(result.ok).toBe(true);
    expect(result.directive?.instructions).toContain('{ y() }');
  });

  it('fails cleanly when no JSON is present, preserving raw output', () => {
    const result = parseDirective('I think we should refactor everything, no JSON for you.');
    expect(result.ok).toBe(false);
    expect(result.rawOutput).toContain('refactor everything');
    expect(result.error).toMatch(/No JSON/);
  });

  it('fails cleanly when JSON does not match the schema', () => {
    const result = parseDirective('```json\n{"actor": "codex", "action": "nope"}\n```');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schema/i);
  });

  it('picks the valid candidate when multiple JSON objects exist', () => {
    const text = `{"unrelated": true}\n\n\`\`\`json\n${JSON.stringify(validDirective)}\n\`\`\``;
    const result = parseDirective(text);
    expect(result.ok).toBe(true);
  });
});
