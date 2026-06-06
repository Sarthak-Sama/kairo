import type { ProcessRunner } from './process-runner.js';
import type { KairoConfig } from '../core/config.js';
import { ClaudeCliAdapter, type ClaudeAdapter } from './claude.js';
import { ClaudePtyAdapter } from './claude-pty.js';

/**
 * Select the Claude transport from config.
 * "print" (default) is the proven `claude -p` subprocess path;
 * "pty" is the opt-in PTY transport.
 */
export function createClaudeAdapter(
  runner: ProcessRunner,
  config: KairoConfig,
  repoRoot: string,
): ClaudeAdapter {
  switch (config.claude.transport) {
    case 'pty':
      return new ClaudePtyAdapter(runner, config, repoRoot);
    case 'print':
      return new ClaudeCliAdapter(runner, config, repoRoot);
  }
}
