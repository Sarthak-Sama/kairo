import { describe, it, expect } from 'vitest';
import { captureDiff, captureBaseline, unquoteGitPath } from '../../src/core/diff.js';
import { MockProcessRunner } from '../helpers/mocks.js';

describe('unquoteGitPath', () => {
  it('passes plain paths through', () => {
    expect(unquoteGitPath('src/index.ts')).toBe('src/index.ts');
  });

  it('unquotes paths with spaces', () => {
    expect(unquoteGitPath('"with space.txt"')).toBe('with space.txt');
  });

  it('unquotes escaped quotes and backslashes', () => {
    expect(unquoteGitPath('"a\\"b.txt"')).toBe('a"b.txt');
    expect(unquoteGitPath('"a\\\\b.txt"')).toBe('a\\b.txt');
  });

  it('decodes octal-escaped UTF-8 sequences', () => {
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt');
  });
});

describe('captureBaseline', () => {
  it('records git state for a repo', async () => {
    const runner = new MockProcessRunner();
    const baseline = await captureBaseline(runner, '/repo');
    expect(baseline.isGitRepo).toBe(true);
    expect(baseline.headSha).toBe('abc123def456');
    expect(baseline.branch).toBe('main');
    expect(baseline.dirty).toBe(false);
  });

  it('reports non-git directories honestly', async () => {
    const runner = new MockProcessRunner();
    runner.on(/is-inside-work-tree/, { exitCode: 128, stdout: '' });
    const baseline = await captureBaseline(runner, '/not-repo');
    expect(baseline.isGitRepo).toBe(false);
    expect(baseline.headSha).toBeNull();
  });
});

describe('captureDiff', () => {
  it('parses changed files including quoted untracked paths', async () => {
    const runner = new MockProcessRunner();
    runner.on(/status --porcelain/, {
      stdout: ' M src/a.ts\n?? "new file.ts"\nR  old.ts -> new.ts\n',
    });
    runner.on(/^git diff HEAD/, { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+x' });
    runner.on(/--no-index/, { exitCode: 1, stdout: 'diff --git a/dev/null b/new file.ts\n+content' });

    const diff = await captureDiff(runner, '/repo');
    expect(diff.available).toBe(true);
    expect(diff.changedFiles).toEqual(['src/a.ts', 'new file.ts', 'new.ts']);
    // Untracked file path is shell-quoted with single quotes in the command
    const noIndexCmd = runner.commands.find((c) => c.includes('--no-index'));
    expect(noIndexCmd).toContain(`'new file.ts'`);
    expect(diff.patch).toContain('+content');
  });

  it('reports unavailability outside a git repo', async () => {
    const runner = new MockProcessRunner();
    runner.on(/is-inside-work-tree/, { exitCode: 128 });
    const diff = await captureDiff(runner, '/not-repo');
    expect(diff.available).toBe(false);
    expect(diff.note).toMatch(/Not a git repository/);
  });
});
