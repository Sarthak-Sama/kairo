import { describe, it, expect } from 'vitest';
import { extractClaudeReport } from '../../src/core/orchestrator.js';

const REAL_REPORT = `# Phase 1 Report
## Changed Files
- src/feature.txt
## Commands Run
- (none)
## Risks
none
## Phase Complete
yes — done`;

describe('extractClaudeReport', () => {
  it('extracts the report from a normal print-mode transcript', () => {
    const transcript = `Working on it...\nsome tool output\n\n${REAL_REPORT}`;
    const report = extractClaudeReport(transcript);
    expect(report).toBe(REAL_REPORT);
  });

  it('PTY transcript with the echoed prompt template extracts the FINAL actual report', () => {
    // The PTY echoes the prompt, which itself contains the report template
    // header — extraction must not stop at that first echoed occurrence.
    const echoedPrompt = `You are the implementation lead for one phase...
## Required report
End your reply with a markdown report in exactly this structure:

# Phase 1 Report
## Changed Files
(list every file you created/modified/deleted)
## Commands Run
(list shell commands you ran)`;
    const transcript = `${echoedPrompt}\n\nWorking on phase 1...\n\n${REAL_REPORT}`;
    const report = extractClaudeReport(transcript);
    expect(report).toBe(REAL_REPORT);
    expect(report).not.toContain('(list every file');
  });

  it('falls back to the transcript tail when no report marker exists', () => {
    const report = extractClaudeReport('I did some work but forgot the report format.');
    expect(report).toContain('no structured report found');
    expect(report).toContain('forgot the report format');
  });

  it('handles an empty transcript', () => {
    expect(extractClaudeReport('')).toBe('(empty transcript)');
  });

  it('strips ANSI/OSC sequences, CRLF, and control bytes from PTY transcripts', () => {
    // Modeled on real Claude Code 2.1.167 PTY output: CRLF line endings plus
    // terminal mode-reset sequences emitted at exit.
    const crlfReport = REAL_REPORT.replace(/\n/g, '\r\n');
    const transcript = `\x1b[?25lWorking...\r\n${crlfReport}\r\n\x1b[?1006l\x1b[?1003l\x1b(B\x0f\x1b[>4m\x1b[?25h\x1b7\x1b[r\x1b8\x1b]9;4;0;\x07\x1b]0;\x07`;
    const report = extractClaudeReport(transcript);
    expect(report).toBe(REAL_REPORT); // clean LF report, no escapes, no trailing noise
  });

  it('does not let escape-wrapped headers break extraction', () => {
    const transcript = `\x1b[1m# Phase 2 Report\x1b[0m\n## Changed Files\n- a.ts\n## Phase Complete\nyes`;
    const report = extractClaudeReport(transcript);
    expect(report.startsWith('# Phase 2 Report')).toBe(true);
    expect(report).not.toContain('\x1b');
  });
});
