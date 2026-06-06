#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { inspectCommand } from './commands/inspect.js';
import { checkCommand } from './commands/check.js';
import { reportCommand } from './commands/report.js';
import { resumeCommand } from './commands/resume.js';
import { askCommand } from './commands/ask.js';
import { ConfigError } from './core/config.js';

const program = new Command();

program
  .name('kairo')
  .description('CLI-first local agency runtime coordinating Codex CLI and Claude Code')
  .version('0.1.0');

const repoRoot = process.cwd();

function wrap(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[kairo] ${err.message}`);
      } else {
        console.error(`[kairo] error: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  };
}

program
  .command('init')
  .description('Initialize Kairo in the current directory (.kairo/config.json)')
  .action(wrap(() => initCommand(repoRoot)));

program
  .command('run')
  .argument('<task>', 'task description')
  .description('Run a task through the Codex/Claude agency loop')
  .action((task: string) => wrap(() => runCommand(repoRoot, task))());

program
  .command('resume')
  .argument('<task-id>', 'task id (or unique fragment)')
  .description('Resume a paused task (awaiting plan approval or user decision)')
  .action((taskId: string) => wrap(() => resumeCommand(repoRoot, taskId))());

program
  .command('ask')
  .argument('<task-id>', 'task id (or unique fragment)')
  .argument('<message>', 'answer/feedback for the pending decision')
  .description('Answer a paused task non-interactively (approval, feedback, or decision)')
  .action((taskId: string, message: string) => wrap(() => askCommand(repoRoot, taskId, message))());

program
  .command('status')
  .description('List all tasks and their states')
  .action(wrap(() => statusCommand(repoRoot)));

program
  .command('logs')
  .argument('<task-id>', 'task id (or unique fragment)')
  .description('Show the agency event log for a task')
  .action((taskId: string) => wrap(() => logsCommand(repoRoot, taskId))());

program
  .command('inspect')
  .argument('<task-id>', 'task id (or unique fragment)')
  .description('Show task details, state history, and artifact tree')
  .action((taskId: string) => wrap(() => inspectCommand(repoRoot, taskId))());

program
  .command('check')
  .argument('<task-id>', 'task id (or unique fragment)')
  .description('Re-run configured checks and record results for a task')
  .action((taskId: string) => wrap(() => checkCommand(repoRoot, taskId))());

program
  .command('report')
  .argument('<task-id>', 'task id (or unique fragment)')
  .description('Print the final report for a task')
  .action((taskId: string) => wrap(() => reportCommand(repoRoot, taskId))());

program.parseAsync(process.argv);
