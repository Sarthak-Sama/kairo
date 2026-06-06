import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { configExists, writeDefaultConfig } from '../core/config.js';
import { ensureDir, fileExists, readText, appendText } from '../utils/fs.js';

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
  // next `kairo run` would (correctly) block on. `.git/info/exclude` is the
  // local, untracked equivalent.
  const gitDir = join(repoRoot, '.git');
  let isGitDirectory = false;
  try {
    isGitDirectory = (await stat(gitDir)).isDirectory();
  } catch {
    isGitDirectory = false;
  }
  if (!isGitDirectory) {
    if (await fileExists(gitDir)) {
      // .git is a file (worktree/submodule) — exclude lives elsewhere; don't guess.
      console.log(
        '[kairo] note: .git is not a directory (worktree?); add .kairo/ to your git ignore rules manually',
      );
    }
    return;
  }

  if (await isKairoIgnored(repoRoot, gitDir)) {
    return; // already ignored — nothing to do
  }

  const excludePath = join(gitDir, 'info', 'exclude');
  const existing = (await fileExists(excludePath)) ? await readText(excludePath) : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await appendText(excludePath, `${separator}.kairo/\n`);
  console.log('[kairo] added .kairo/ to .git/info/exclude (local ignore, working tree untouched)');
}

/** True if .kairo/ is already covered by .gitignore or .git/info/exclude. */
async function isKairoIgnored(repoRoot: string, gitDir: string): Promise<boolean> {
  for (const path of [join(repoRoot, '.gitignore'), join(gitDir, 'info', 'exclude')]) {
    if (!(await fileExists(path))) continue;
    const lines = (await readText(path)).split('\n').map((l) => l.trim());
    if (lines.some((l) => l === '.kairo/' || l === '.kairo')) return true;
  }
  return false;
}
