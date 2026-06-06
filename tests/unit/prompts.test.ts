import { describe, it, expect } from 'vitest';
import { buildSelfEditPrompt, buildTriagePrompt } from '../../src/core/prompts.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

describe('triage prompt', () => {
  const prompt = buildTriagePrompt({
    taskTitle: 'Fix typo',
    repoScanMarkdown: '# Repo Scan\n- Files: 3',
    config: DEFAULT_CONFIG,
  });

  it('declares the session read-only and forbids editing during triage', () => {
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toMatch(/must not modify/i);
  });

  it('no longer tells Codex to edit during triage', () => {
    expect(prompt).not.toContain('make the edits yourself now');
  });

  it('explains self_edit means a separate write-enabled invocation', () => {
    expect(prompt).toMatch(/invoke you again in a separate write-enabled/i);
  });

  it('declares instructions REQUIRED for implementation-bearing actions', () => {
    // Live finding: real Codex emitted continue_next_phase without
    // instructions because the contract never said they were mandatory.
    expect(prompt).toMatch(/"instructions" is REQUIRED for .*"continue_next_phase"/);
  });
});

describe('self-edit prompt', () => {
  const prompt = buildSelfEditPrompt({
    taskTitle: 'Fix typo',
    phase: 1,
    instructions: 'Change "teh" to "the" in README.md.',
    masterPlan: 'One-line typo fix.',
  });

  it('is explicitly the write-enabled session with the directive instructions', () => {
    expect(prompt).toContain('WRITE-ENABLED');
    expect(prompt).toContain('Change "teh" to "the" in README.md.');
  });

  it('forbids commits and requires a final summary', () => {
    expect(prompt).toContain('Do NOT commit');
    expect(prompt).toMatch(/final message/i);
  });
});
