import { describe, it, expect } from 'vitest';
import { generateReport, decideCommitRecommendation } from '../../src/core/report.js';
import type { Task } from '../../src/core/task-store.js';
import type { CheckResult } from '../../src/core/checks.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: 'Add keyboard shortcut modal',
    state: 'reported',
    createdAt: '2026-06-06T10:00:00.000Z',
    updatedAt: '2026-06-06T10:30:00.000Z',
    repoRoot: '/repo',
    baseline: { isGitRepo: true, headSha: 'abc', branch: 'main', dirty: false },
    currentPhase: 1,
    revisionCount: 0,
    modelCalls: 3,
    outcome: 'completed',
    lane: null,
    laneSource: null,
    profile: null,
    team: null,
    pending: null,
    stateHistory: [],
    ...overrides,
  };
}

function check(name: string, status: CheckResult['status']): CheckResult {
  return { name, command: `pnpm ${name}`, status, exitCode: status === 'passed' ? 0 : 1, durationMs: 10, outputTail: '' };
}

const cleanBase = {
  outcome: 'completed',
  checkResults: [check('test', 'passed'), check('typecheck', 'passed')],
  reviewHasBlockers: false,
  highRisk: false,
  mediumRisk: false,
  diffUnavailable: false,
};

describe('commit recommendation', () => {
  it('safe to commit only when everything is clean', () => {
    expect(decideCommitRecommendation(cleanBase)).toBe('safe to commit');
  });

  it('needs manual review when checks were skipped', () => {
    expect(
      decideCommitRecommendation({
        ...cleanBase,
        checkResults: [check('test', 'passed'), check('lint', 'skipped')],
      }),
    ).toBe('needs manual review');
  });

  it('needs manual review when no checks ran at all', () => {
    expect(decideCommitRecommendation({ ...cleanBase, checkResults: [] })).toBe('needs manual review');
  });

  it('needs manual review on medium-risk warnings', () => {
    expect(decideCommitRecommendation({ ...cleanBase, mediumRisk: true })).toBe('needs manual review');
  });

  it('needs manual review when outcome is not completed', () => {
    expect(decideCommitRecommendation({ ...cleanBase, outcome: 'awaiting_plan_approval' })).toBe(
      'needs manual review',
    );
  });

  it('not safe to commit when a check failed', () => {
    expect(
      decideCommitRecommendation({ ...cleanBase, checkResults: [check('test', 'failed')] }),
    ).toBe('not safe to commit');
  });

  it('not safe to commit when a check was blocked', () => {
    expect(
      decideCommitRecommendation({ ...cleanBase, checkResults: [check('evil', 'blocked')] }),
    ).toBe('not safe to commit');
  });

  it('not safe to commit on failed/blocked/unsafe/interrupted outcomes', () => {
    for (const outcome of ['failed', 'blocked', 'unsafe', 'interrupted']) {
      expect(decideCommitRecommendation({ ...cleanBase, outcome })).toBe('not safe to commit');
    }
  });

  it('not safe to commit when review has blockers', () => {
    expect(decideCommitRecommendation({ ...cleanBase, reviewHasBlockers: true })).toBe(
      'not safe to commit',
    );
  });

  it('not safe to commit on high risk', () => {
    expect(decideCommitRecommendation({ ...cleanBase, highRisk: true })).toBe('not safe to commit');
  });

  it('not safe to commit when diff was unavailable', () => {
    expect(decideCommitRecommendation({ ...cleanBase, diffUnavailable: true })).toBe(
      'not safe to commit',
    );
  });
});

describe('report generation', () => {
  const baseInput = {
    task: makeTask(),
    events: [
      {
        timestamp: '2026-06-06T10:00:00.000Z',
        actor: 'kairo' as const,
        action: 'task_created',
        status: 'completed' as const,
        message: 'task created',
        metadata: {},
      },
    ],
    changedFiles: ['src/modal.tsx'],
    commandsRun: ['pnpm test'],
    checkResults: [check('test', 'passed')],
    codexReview: 'Implementation matches plan. No blockers.',
    risks: [] as string[],
    scope: 'One modal component plus a keyboard hook.',
    summary: 'Built the shortcut modal.',
    followUp: ['Add e2e test'],
  };

  it('renders all required sections', () => {
    const report = generateReport(baseInput);
    for (const section of [
      '# Task Report: Add keyboard shortcut modal',
      '## Summary',
      '## Outcome',
      '## Scope',
      '## Agency Timeline',
      '## Files Changed',
      '## Commands Run',
      '## Verification',
      '## Codex Review',
      '## Risks',
      '## Follow-up',
      '## Commit Recommendation',
    ]) {
      expect(report).toContain(section);
    }
    expect(report).toContain('src/modal.tsx');
    expect(report).toContain('**safe to commit**');
  });

  it('downgrades recommendation when the review mentions blockers', () => {
    const report = generateReport({
      ...baseInput,
      codexReview: 'BLOCKER: race condition in modal close handler.',
    });
    expect(report).toContain('**not safe to commit**');
  });

  it('high-prefixed risks force not safe to commit', () => {
    const report = generateReport({
      ...baseInput,
      risks: ['high: phase 1 directive was flagged high risk by Codex'],
    });
    expect(report).toContain('**not safe to commit**');
    expect(report).toContain('flagged high risk');
  });

  it('medium-prefixed risks force needs manual review', () => {
    const report = generateReport({
      ...baseInput,
      risks: ['medium: 1 check(s) were skipped (lint) — verify manually'],
    });
    expect(report).toContain('**needs manual review**');
  });

  it('diff unavailable forces not safe to commit and is called out in Verification', () => {
    const report = generateReport({ ...baseInput, diffUnavailable: true });
    expect(report).toContain('**not safe to commit**');
    expect(report).toContain('capture was UNAVAILABLE');
  });

  it('includes the baseline note in Verification', () => {
    const report = generateReport({
      ...baseInput,
      baselineNote: 'clean working tree at main@abc12345 before implementation',
    });
    expect(report).toContain('**baseline**: clean working tree at main@abc12345');
  });

  it('renders the operating profile section with a profile name', () => {
    const report = generateReport({
      ...baseInput,
      operatingProfile: { profile: 'daily', head: 'claude', developmentLead: 'claude' },
    });
    expect(report).toContain('## Operating Profile');
    expect(report).toContain('- Profile: daily');
    expect(report).toContain('- Head planner/reviewer: claude');
    expect(report).toContain('- Development lead: claude');
  });

  it('renders profile: none when no profile was used', () => {
    const report = generateReport({
      ...baseInput,
      operatingProfile: { profile: null, head: 'codex', developmentLead: 'claude' },
    });
    expect(report).toContain('- Profile: none');
    expect(report).toContain('- Head planner/reviewer: codex');
  });

  it('renders the Quality Lane section', () => {
    const report = generateReport({
      ...baseInput,
      qualityLane: { lane: 'feature', source: 'user-selected', requiredChecks: ['typecheck', 'lint', 'test', 'build'] },
    });
    expect(report).toContain('## Quality Lane');
    expect(report).toContain('- Lane: feature');
    expect(report).toContain('- Source: user-selected');
    expect(report).toContain('- Required checks: typecheck, lint, test, build');
  });

  it('omits the Quality Lane section when no lane is set (legacy)', () => {
    expect(generateReport(baseInput)).not.toContain('## Quality Lane');
  });

  it('reflects failed outcome in the Outcome section', () => {
    const report = generateReport({
      ...baseInput,
      task: makeTask({ outcome: 'failed' }),
      checkResults: [],
      summary: 'It broke.',
    });
    expect(report).toMatch(/## Outcome\n\nfailed/);
    expect(report).toContain('**not safe to commit**');
  });
});
