import { describe, it, expect } from 'vitest';
import { laneDefinition, inferLane, laneMenuMarkdown, QUALITY_LANES } from '../../src/core/lanes.js';
import { DirectiveSchema } from '../../src/core/directives.js';
import { requiresPlanApproval } from '../../src/core/orchestrator.js';

describe('quality lane definitions', () => {
  it('exposes exactly the five v0 lanes', () => {
    expect([...QUALITY_LANES]).toEqual(['copy', 'bugfix', 'feature', 'refactor', 'risky']);
  });

  it('encodes the required checks per lane', () => {
    expect(laneDefinition('copy').requiredChecks).toEqual(['typecheck', 'lint']);
    expect(laneDefinition('bugfix').requiredChecks).toEqual(['typecheck', 'test']);
    for (const lane of ['feature', 'refactor', 'risky'] as const) {
      expect(laneDefinition(lane).requiredChecks).toEqual(['typecheck', 'lint', 'test', 'build']);
    }
  });

  it('encodes approval policy and unrun-check risk', () => {
    expect(laneDefinition('copy').approval).toBe('quick-bypass');
    expect(laneDefinition('bugfix').approval).toBe('delegation');
    expect(laneDefinition('feature').approval).toBe('always');
    expect(laneDefinition('refactor').approval).toBe('always');
    expect(laneDefinition('risky').approval).toBe('always');
    expect(laneDefinition('copy').unrunCheckRisk).toBe('medium');
    expect(laneDefinition('feature').unrunCheckRisk).toBe('high');
    expect(laneDefinition('risky').unrunCheckRisk).toBe('high');
  });

  it('the lane menu lists every lane', () => {
    const menu = laneMenuMarkdown();
    for (const lane of QUALITY_LANES) expect(menu).toContain(`"${lane}"`);
  });
});

describe('inferLane (conservative fallback)', () => {
  it('classifies risky for auth/payment/migration/security signals or high risk', () => {
    expect(inferLane({ text: 'update authentication wording' })).toBe('risky');
    expect(inferLane({ text: 'add a stripe payment flow' })).toBe('risky');
    expect(inferLane({ text: 'run the database migration' })).toBe('risky');
    expect(inferLane({ text: 'anything', risk: 'high' })).toBe('risky');
  });

  it('classifies refactor, bugfix, and copy from intent words', () => {
    expect(inferLane({ text: 'refactor the parser internals' })).toBe('refactor');
    expect(inferLane({ text: 'fix the broken pagination' })).toBe('bugfix');
    expect(inferLane({ text: 'tweak the marquee wording' })).toBe('copy');
  });

  it('defaults to feature when ambiguous (stricter)', () => {
    expect(inferLane({ text: 'add a greeting helper component' })).toBe('feature');
    expect(inferLane({ text: 'do the thing' })).toBe('feature');
  });
});

describe('directive lane field', () => {
  const base = {
    actor: 'head',
    action: 'delegate_to_development_lead',
    requiresUserInput: false,
    risk: 'low',
    reason: 'r',
    instructions: 'do it',
  };

  it('accepts canonical directives carrying a valid lane', () => {
    const parsed = DirectiveSchema.parse({ ...base, lane: 'feature' });
    expect(parsed.lane).toBe('feature');
  });

  it('parses legacy directives without a lane (lane undefined)', () => {
    const parsed = DirectiveSchema.parse(base);
    expect(parsed.lane).toBeUndefined();
  });

  it('rejects invalid lane values', () => {
    expect(DirectiveSchema.safeParse({ ...base, lane: 'urgent' }).success).toBe(false);
  });
});

describe('requiresPlanApproval with lane policy', () => {
  function directive(overrides: Record<string, unknown>) {
    return DirectiveSchema.parse({ actor: 'head', reason: 'r', ...overrides });
  }

  it('feature/refactor/risky implementation actions always require approval', () => {
    for (const lane of ['feature', 'refactor', 'risky'] as const) {
      // even a tiny low-risk quick self-edit
      expect(requiresPlanApproval(
        directive({ action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit', reason: 'tiny', instructions: 'one line' }),
        lane,
      )).toBe(true);
    }
  });

  it('bugfix requires approval for delegation but allows a tiny self-edit', () => {
    expect(requiresPlanApproval(directive({ action: 'delegate_to_development_lead', instructions: 'fix it' }), 'bugfix')).toBe(true);
    expect(requiresPlanApproval(
      directive({ action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit', reason: 'tiny', instructions: 'one line' }),
      'bugfix',
    )).toBe(false);
  });

  it('copy keeps the conservative quick-self-edit bypass', () => {
    expect(requiresPlanApproval(
      directive({ action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit', reason: 'fix wording', instructions: 'change one string' }),
      'copy',
    )).toBe(false);
    // but a feature-shaped copy self-edit still gates (existing signal rule)
    expect(requiresPlanApproval(
      directive({ action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit', reason: 'add component', instructions: 'create a new component' }),
      'copy',
    )).toBe(true);
  });
});
