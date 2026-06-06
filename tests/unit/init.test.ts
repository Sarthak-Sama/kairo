import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { initCommand } from '../../src/commands/init.js';
import { fileExists, readText, writeText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

function git(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir }).toString().trim();
}

function gitInit(dir: string): void {
  git(dir, 'init -q');
  git(dir, 'config user.email t@t.t');
  git(dir, 'config user.name t');
}

function isIgnored(dir: string): boolean {
  try {
    git(dir, 'check-ignore .kairo');
    return true;
  } catch {
    return false;
  }
}

describe('kairo init', () => {
  let dir: string;
  let extraDirs: string[];

  beforeEach(async () => {
    dir = await makeTempDir();
    extraDirs = [];
  });

  afterEach(async () => {
    await cleanupDir(dir);
    for (const d of extraDirs) await cleanupDir(d);
  });

  const gitignorePath = () => join(dir, '.gitignore');
  const excludePath = () => join(dir, '.git', 'info', 'exclude');

  it('creates config and task/log directories', async () => {
    await initCommand(dir);
    expect(await fileExists(join(dir, '.kairo', 'config.json'))).toBe(true);
    expect(await fileExists(join(dir, '.kairo', 'tasks'))).toBe(true);
    expect(await fileExists(join(dir, '.kairo', 'logs'))).toBe(true);
  });

  it('in a git repo: ignores .kairo/ via the git-resolved exclude, never touches .gitignore', async () => {
    gitInit(dir);
    await initCommand(dir);
    expect(isIgnored(dir)).toBe(true);
    expect(await readText(excludePath())).toContain('.kairo/');
    // H-1 regression: the working tree must stay clean — no .gitignore created.
    expect(await fileExists(gitignorePath())).toBe(false);
    expect(git(dir, 'status --porcelain')).toBe('');
  });

  it('in a git WORKTREE (.git is a file): resolves the exclude via git and works without manual steps', async () => {
    gitInit(dir);
    await writeText(join(dir, 'a.txt'), 'x\n');
    git(dir, 'add -A');
    git(dir, 'commit -qm base');
    const worktree = `${dir}-wt`;
    extraDirs.push(worktree);
    git(dir, `worktree add -q ${JSON.stringify(worktree)} -b wt-branch`);

    await initCommand(worktree);

    expect(isIgnored(worktree)).toBe(true); // dogfood regression: no manual ignore handling
    expect(await fileExists(join(worktree, '.gitignore'))).toBe(false);
    expect(git(worktree, 'status --porcelain')).toBe('');
  });

  it('does not modify an existing .gitignore', async () => {
    gitInit(dir);
    await writeText(gitignorePath(), 'node_modules/\n');
    git(dir, 'add -A');
    git(dir, 'commit -qm base');
    await initCommand(dir);
    expect(await readText(gitignorePath())).toBe('node_modules/\n');
    expect(isIgnored(dir)).toBe(true);
    expect(git(dir, 'status --porcelain')).toBe('');
  });

  it('does nothing when .gitignore already ignores .kairo/', async () => {
    gitInit(dir);
    await writeText(gitignorePath(), '.kairo/\n');
    await initCommand(dir);
    const exclude = (await fileExists(excludePath())) ? await readText(excludePath()) : '';
    expect(exclude).not.toContain('.kairo');
  });

  it('does not duplicate an existing exclude entry', async () => {
    gitInit(dir);
    await writeText(excludePath(), '.kairo/\n');
    await initCommand(dir);
    expect((await readText(excludePath())).match(/\.kairo\//g)).toHaveLength(1);
  });

  it('appends with a separating newline when exclude lacks a trailing one', async () => {
    gitInit(dir);
    await writeText(excludePath(), '*.tmp'); // no trailing newline
    await initCommand(dir);
    expect(await readText(excludePath())).toBe('*.tmp\n.kairo/\n');
  });

  it('in a non-git directory: creates no ignore files at all', async () => {
    await initCommand(dir);
    expect(await fileExists(gitignorePath())).toBe(false);
    expect(await fileExists(excludePath())).toBe(false);
  });

  it('is idempotent: a second init changes nothing', async () => {
    gitInit(dir);
    await initCommand(dir);
    const before = await readText(excludePath());
    await initCommand(dir);
    expect(await readText(excludePath())).toBe(before);
  });
});
