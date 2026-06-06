import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configExists, writeDefaultConfig } from '../core/config.js';
import { ensureDir, fileExists, readText, appendText } from '../utils/fs.js';

const execFileAsync = promisify(execFile);

export async function initCommand(repoRoot: string): Promise<void> {
  if (await configExists(repoRoot)) {
    console.log(`[kairo] already initialized: ${join(repoRoot, '.kairo', 'config.json')}`);
    return;
  }
  const configPath = await writeDefaultConfig(repoRoot);
  await ensureDir(join(repoRoot, '.kairo', 'tasks'));
  await ensureDir(join(repoRoot, '.kairo', 'logs'));
  console.log(`[kairo] initialized: ${configPath}`);

  // Keep .kairo/ out of version control WITHOUT dirtying the working tree:
  // a .gitignore edit would itself be an uncommitted change, which the very
  // next `kairo run` would (correctly) block on. Git resolves the local
  // exclude file itself (`git rev-parse --git-path info/exclude`), which is
  // correct in normal repos AND worktrees — no guessing at .git layouts.
  const excludePath = await resolveGitExcludePath(repoRoot);
  if (excludePath === null) {
    return; // not a git repository — nothing to ignore-manage
  }

  if (await isKairoIgnored(repoRoot, excludePath)) {
    return; // already ignored — nothing to do
  }

  const existing = (await fileExists(excludePath)) ? await readText(excludePath) : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await appendText(excludePath, `${separator}.kairo/\n`);
  console.log(`[kairo] added .kairo/ to ${excludePath} (local ignore, working tree untouched)`);
}

/** Ask git itself where the local exclude file lives; null if not a git repo. */
async function resolveGitExcludePath(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repoRoot,
    });
    const path = stdout.trim();
    if (!path) return null;
    return isAbsolute(path) ? path : join(repoRoot, path);
  } catch {
    return null;
  }
}

/** True if .kairo/ is already covered by .gitignore or the resolved exclude file. */
async function isKairoIgnored(repoRoot: string, excludePath: string): Promise<boolean> {
  for (const path of [join(repoRoot, '.gitignore'), excludePath]) {
    if (!(await fileExists(path))) continue;
    const lines = (await readText(path)).split('\n').map((l) => l.trim());
    if (lines.some((l) => l === '.kairo/' || l === '.kairo')) return true;
  }
  return false;
}
