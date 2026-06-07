import { join } from 'node:path';
import { loadConfig } from '../core/config.js';

/** Launch the operator console. Requires an interactive terminal. */
export async function tuiCommand(repoRoot: string, taskIdPartial?: string): Promise<void> {
  if (process.stdin.isTTY !== true) {
    console.error('[kairo] kairo tui requires an interactive terminal (stdin is not a TTY)');
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(repoRoot);
  const artifactRoot = join(repoRoot, config.artifactDir);
  // Dynamic import keeps Ink/React out of every other command's startup path.
  const { runTui } = await import('../tui/app.js');
  await runTui(repoRoot, artifactRoot, taskIdPartial);
}
