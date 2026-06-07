import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import {
  createAgentTeam,
  CodexHeadAdapter,
  ClaudeHeadAdapter,
  CodexDevelopmentLeadAdapter,
  ClaudeDevelopmentLeadAdapter,
} from '../../src/adapters/team.js';
import { MockProcessRunner } from '../helpers/mocks.js';
import type { RunOptions, RunResult } from '../../src/adapters/process-runner.js';

const REPO = '/repo';

function makeConfig(head: 'codex' | 'claude', developmentLead: 'codex' | 'claude') {
  return ConfigSchema.parse({ version: 1, roles: { head, developmentLead } });
}

/** Runner that records commands and returns success with canned stdout. */
class RecordingRunner extends MockProcessRunner {
  override async runShell(command: string, options: RunOptions): Promise<RunResult> {
    const base = await super.runShell(command, options);
    return { ...base, stdout: base.stdout || 'ok-output' };
  }
}

describe('createAgentTeam', () => {
  it('default config builds the original team: codex head, claude development lead', () => {
    const team = createAgentTeam(new MockProcessRunner(), ConfigSchema.parse({ version: 1 }), REPO);
    expect(team.head).toBeInstanceOf(CodexHeadAdapter);
    expect(team.head.provider).toBe('codex');
    expect(team.developmentLead).toBeInstanceOf(ClaudeDevelopmentLeadAdapter);
    expect(team.developmentLead.provider).toBe('claude');
  });

  it('builds all four role combinations', () => {
    const combos: Array<['codex' | 'claude', 'codex' | 'claude']> = [
      ['codex', 'claude'],
      ['claude', 'claude'],
      ['claude', 'codex'],
      ['codex', 'codex'],
    ];
    for (const [head, dev] of combos) {
      const team = createAgentTeam(new MockProcessRunner(), makeConfig(head, dev), REPO);
      expect(team.head.provider).toBe(head);
      expect(team.developmentLead.provider).toBe(dev);
      expect(team.head).toBeInstanceOf(head === 'codex' ? CodexHeadAdapter : ClaudeHeadAdapter);
      expect(team.developmentLead).toBeInstanceOf(
        dev === 'codex' ? CodexDevelopmentLeadAdapter : ClaudeDevelopmentLeadAdapter,
      );
    }
  });
});

describe('role access mapping', () => {
  it('codex head: read access -> read-only sandbox, write access -> configured sandbox', async () => {
    const runner = new RecordingRunner();
    const head = new CodexHeadAdapter(runner, makeConfig('codex', 'claude'), REPO);
    await head.invoke({ prompt: 'plan it', purpose: 'triage', access: 'read' });
    await head.invoke({ prompt: 'edit it', purpose: 'self-edit-phase-1', access: 'write' });
    expect(runner.commands[0]).toContain(`--sandbox 'read-only'`);
    expect(runner.commands[1]).toContain(`--sandbox 'workspace-write'`);
  });

  it('claude head: read access uses headPermissionMode "plan", write uses implementation mode', async () => {
    const runner = new RecordingRunner();
    const head = new ClaudeHeadAdapter(runner, makeConfig('claude', 'claude'), REPO);
    await head.invoke({ prompt: 'plan it', purpose: 'triage', access: 'read' });
    await head.invoke({ prompt: 'edit it', purpose: 'self-edit-phase-1', access: 'write' });
    expect(runner.commands[0]).toContain(`--permission-mode 'plan'`);
    // implementation mode "auto" maps to Claude's acceptEdits
    expect(runner.commands[1]).toContain(`--permission-mode 'acceptEdits'`);
  });

  it('codex development lead always uses the write-enabled sandbox', async () => {
    const runner = new RecordingRunner();
    const dev = new CodexDevelopmentLeadAdapter(runner, makeConfig('claude', 'codex'), REPO);
    const chunks: string[] = [];
    const result = await dev.invoke({ prompt: 'build it', purpose: 'phase-1', onChunk: (c) => chunks.push(c) });
    expect(runner.commands[0]).toContain(`--sandbox 'workspace-write'`);
    expect(result.ok).toBe(true);
    expect(chunks.length).toBe(1); // non-streaming: one chunk at completion
  });

  it('claude development lead uses the implementation permission mode', async () => {
    const runner = new RecordingRunner();
    const dev = new ClaudeDevelopmentLeadAdapter(runner, makeConfig('codex', 'claude'), REPO);
    await dev.invoke({ prompt: 'build it', purpose: 'phase-1' });
    expect(runner.commands[0]).toContain(`--permission-mode 'acceptEdits'`);
    expect(runner.commands[0]).not.toContain('plan');
  });
});
