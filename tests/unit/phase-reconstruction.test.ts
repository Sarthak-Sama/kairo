import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  reconstructPhases,
  changedFilesFromPatch,
} from '../../src/core/phase-reconstruction.js';
import { writeJson, writeText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('changedFilesFromPatch', () => {
  it('extracts files from diff --git headers', () => {
    const patch = `diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/src/b.ts b/src/b.ts\n+y\n`;
    expect(changedFilesFromPatch(patch)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty for placeholder/non-patch content', () => {
    expect(changedFilesFromPatch('# no changes detected\n')).toEqual([]);
  });
});

describe('reconstructPhases', () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(taskDir);
  });

  it('returns empty for a task with no phase folders', async () => {
    expect(await reconstructPhases(taskDir)).toEqual([]);
  });

  it('rebuilds a complete phase from artifacts', async () => {
    const p1 = join(taskDir, 'phase-001');
    await writeJson(join(p1, 'codex-directive.json'), { action: 'delegate_to_claude', risk: 'high' });
    await writeText(join(p1, 'claude-report.md'), '# Phase 1 Report\nbuilt the thing');
    await writeText(join(p1, 'diff.patch'), 'diff --git a/src/x.ts b/src/x.ts\n+new');
    await writeJson(join(p1, 'checks.json'), [
      { name: 'test', command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 5, outputTail: '' },
      { name: 'lint', command: 'pnpm lint', status: 'skipped', exitCode: null, durationMs: 0, outputTail: '' },
    ]);
    await writeText(join(p1, 'codex-review.md'), 'looks good');
    await writeJson(join(p1, 'codex-decision.json'), { action: 'declare_complete', risk: 'medium' });

    const phases = await reconstructPhases(taskDir);
    expect(phases).toHaveLength(1);
    const phase = phases[0]!;
    expect(phase.phase).toBe(1);
    expect(phase.directiveRisk).toBe('high');
    expect(phase.reviewRisk).toBe('medium');
    expect(phase.claudeReport).toContain('built the thing');
    expect(phase.review).toBe('looks good');
    expect(phase.changedFiles).toEqual(['src/x.ts']);
    expect(phase.diffAvailable).toBe(true);
    expect(phase.checksRun?.passed).toBe(1);
    expect(phase.checksRun?.skipped).toBe(1);
    expect(phase.checksRun?.allPassedOrSkipped).toBe(true);
  });

  it('uses the self-edit transcript when there is no claude report', async () => {
    const p1 = join(taskDir, 'phase-001');
    await writeText(join(p1, 'codex-self-edit-transcript.md'), 'edited README');
    const phases = await reconstructPhases(taskDir);
    expect(phases[0]?.claudeReport).toContain('head self-edit');
    expect(phases[0]?.claudeReport).toContain('edited README');
  });

  it('fills visible placeholders for missing artifacts instead of crashing', async () => {
    const p2 = join(taskDir, 'phase-002');
    await writeText(join(p2, '.keep'), '');
    const phases = await reconstructPhases(taskDir);
    expect(phases).toHaveLength(1);
    const phase = phases[0]!;
    expect(phase.phase).toBe(2);
    expect(phase.claudeReport).toContain('artifact missing');
    expect(phase.review).toContain('artifact missing');
    expect(phase.checksRun).toBeNull();
    expect(phase.diffAvailable).toBe(false);
    expect(phase.diffNote).toContain('missing');
    expect(phase.directiveRisk).toBe('medium'); // conservative fallback
  });

  it('sorts multiple phases and ignores non-phase folders', async () => {
    await writeText(join(taskDir, 'phase-002', 'claude-report.md'), 'two');
    await writeText(join(taskDir, 'phase-001', 'claude-report.md'), 'one');
    await writeText(join(taskDir, 'not-a-phase', 'x.md'), 'ignore me');
    const phases = await reconstructPhases(taskDir);
    expect(phases.map((p) => p.phase)).toEqual([1, 2]);
  });
});
