import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { initCommand } from '../../src/commands/init.js';
import { fileExists, readText, writeText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('kairo init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  const excludePath = () => join(dir, '.git', 'info', 'exclude');
  const gitignorePath = () => join(dir, '.gitignore');

  it('creates config and task/log directories', async () => {
    await initCommand(dir);
    expect(await fileExists(join(dir, '.kairo', 'config.json'))).toBe(true);
    expect(await fileExists(join(dir, '.kairo', 'tasks'))).toBe(true);
    expect(await fileExists(join(dir, '.kairo', 'logs'))).toBe(true);
  });

  it('in a git repo: adds .kairo/ to .git/info/exclude, never touches .gitignore', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await initCommand(dir);
    expect(await readText(excludePath())).toContain('.kairo/');
    // H-1 regression: the working tree must stay clean — no .gitignore created.
    expect(await fileExists(gitignorePath())).toBe(false);
  });

  it('does not modify an existing .gitignore', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeText(gitignorePath(), 'node_modules/\n');
    await initCommand(dir);
    expect(await readText(gitignorePath())).toBe('node_modules/\n');
    expect(await readText(excludePath())).toContain('.kairo/');
  });

  it('does nothing when .gitignore already ignores .kairo/', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeText(gitignorePath(), '.kairo/\n');
    await initCommand(dir);
    expect(await fileExists(excludePath())).toBe(false);
  });

  it('does not duplicate an existing exclude entry', async () => {
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeText(excludePath(), '.kairo/\n');
    await initCommand(dir);
    const content = await readText(excludePath());
    expect(content.match(/\.kairo\//g)).toHaveLength(1);
  });

  it('appends with a separating newline when exclude lacks a trailing one', async () => {
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
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
    await mkdir(join(dir, '.git'), { recursive: true });
    await initCommand(dir);
    const before = await readText(excludePath());
    await initCommand(dir);
    expect(await readText(excludePath())).toBe(before);
  });
});
