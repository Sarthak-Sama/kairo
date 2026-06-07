import type { ProcessRunner } from './process-runner.js';
import { resolveTeam, type KairoConfig, type AgentProvider } from '../core/config.js';
import { CodexCliAdapter } from './codex.js';
import { createClaudeAdapter } from './claude-factory.js';
import { ClaudeCliAdapter } from './claude.js';
import type { ClaudeAdapter } from './claude.js';
import { parseDirective, type DirectiveParseResult } from '../core/directives.js';

export type { AgentProvider } from '../core/config.js';

/** Unified result for head-role model calls, provider-independent. */
export interface ModelResult {
  ok: boolean;
  /** The final message / response text — what prose and directives are parsed from. */
  output: string;
  /** Fuller raw output where the transport provides one (transcripts, exec logs). */
  raw: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface HeadInvocation {
  prompt: string;
  purpose: string;
  /**
   * "read" for planning/review/decision calls (Codex: read-only sandbox;
   * Claude: headPermissionMode, default "plan"). "write" ONLY for the
   * dedicated self-edit session (Codex: configured sandbox; Claude: the
   * implementation permissionMode).
   */
  access: 'read' | 'write';
}

export interface HeadAgentAdapter {
  provider: AgentProvider;
  displayName: string;
  isAvailable(): Promise<boolean>;
  invoke(invocation: HeadInvocation): Promise<ModelResult>;
  invokeForDirective(invocation: HeadInvocation): Promise<{ result: ModelResult; parsed: DirectiveParseResult }>;
}

export interface ImplementationResult {
  ok: boolean;
  transcript: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface DevLeadInvocation {
  prompt: string;
  purpose: string;
  onChunk?: (chunk: string) => void;
}

export interface DevelopmentLeadAdapter {
  provider: AgentProvider;
  displayName: string;
  isAvailable(): Promise<boolean>;
  invoke(invocation: DevLeadInvocation): Promise<ImplementationResult>;
}

export interface AgentTeam {
  head: HeadAgentAdapter;
  developmentLead: DevelopmentLeadAdapter;
}

/**
 * Build the agency team. By default the team is resolved from config
 * (explicit profile > defaultProfile > roles); pass `team` to pin specific
 * providers — e.g. the team stored on a task being resumed.
 */
export function createAgentTeam(
  runner: ProcessRunner,
  config: KairoConfig,
  repoRoot: string,
  team?: { head: AgentProvider; developmentLead: AgentProvider },
): AgentTeam {
  const resolved = team ?? resolveTeam(config);
  return {
    head:
      resolved.head === 'codex'
        ? new CodexHeadAdapter(runner, config, repoRoot)
        : new ClaudeHeadAdapter(runner, config, repoRoot),
    developmentLead:
      resolved.developmentLead === 'codex'
        ? new CodexDevelopmentLeadAdapter(runner, config, repoRoot)
        : new ClaudeDevelopmentLeadAdapter(runner, config, repoRoot),
  };
}

// ----------------------------------------------------------------- codex --

export class CodexHeadAdapter implements HeadAgentAdapter {
  readonly provider = 'codex' as const;
  readonly displayName = 'codex';
  private readonly codex: CodexCliAdapter;

  constructor(runner: ProcessRunner, private readonly config: KairoConfig, repoRoot: string) {
    this.codex = new CodexCliAdapter(runner, config, repoRoot);
  }

  isAvailable(): Promise<boolean> {
    return this.codex.isAvailable();
  }

  async invoke(invocation: HeadInvocation): Promise<ModelResult> {
    const result = await this.codex.invoke({
      prompt: invocation.prompt,
      purpose: invocation.purpose,
      sandbox: invocation.access === 'read' ? 'read-only' : this.config.codex.sandbox,
    });
    return {
      ok: result.ok,
      output: result.lastMessage,
      raw: result.rawStdout || result.lastMessage,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async invokeForDirective(invocation: HeadInvocation) {
    const result = await this.invoke(invocation);
    const parsed: DirectiveParseResult = result.ok
      ? parseDirective(result.output)
      : { ok: false, rawOutput: result.output, error: result.error ?? 'head invocation failed' };
    return { result, parsed };
  }
}

export class CodexDevelopmentLeadAdapter implements DevelopmentLeadAdapter {
  readonly provider = 'codex' as const;
  readonly displayName = 'codex';
  private readonly codex: CodexCliAdapter;

  constructor(runner: ProcessRunner, private readonly config: KairoConfig, repoRoot: string) {
    this.codex = new CodexCliAdapter(runner, config, repoRoot);
  }

  isAvailable(): Promise<boolean> {
    return this.codex.isAvailable();
  }

  async invoke(invocation: DevLeadInvocation): Promise<ImplementationResult> {
    // Implementation work gets the configured write-enabled sandbox.
    const result = await this.codex.invoke({
      prompt: invocation.prompt,
      purpose: invocation.purpose,
      sandbox: this.config.codex.sandbox,
    });
    const transcript = result.rawStdout || result.lastMessage;
    invocation.onChunk?.(transcript); // codex exec is not streaming; one chunk at completion
    return {
      ok: result.ok,
      transcript,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }
}

// ---------------------------------------------------------------- claude --

export class ClaudeHeadAdapter implements HeadAgentAdapter {
  readonly provider = 'claude' as const;
  readonly displayName = 'claude';
  private readonly claude: ClaudeAdapter;

  constructor(runner: ProcessRunner, private readonly config: KairoConfig, repoRoot: string) {
    // Head work is single-shot text; the proven print transport is the right
    // transport regardless of the development-lead transport setting.
    this.claude = new ClaudeCliAdapter(runner, config, repoRoot);
  }

  isAvailable(): Promise<boolean> {
    return this.claude.isAvailable();
  }

  async invoke(invocation: HeadInvocation): Promise<ModelResult> {
    const result = await this.claude.invoke({
      prompt: invocation.prompt,
      purpose: invocation.purpose,
      permissionModeOverride:
        invocation.access === 'read'
          ? this.config.claude.headPermissionMode
          : this.config.claude.permissionMode,
    });
    return {
      ok: result.ok,
      output: result.transcript,
      raw: result.transcript,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async invokeForDirective(invocation: HeadInvocation) {
    const result = await this.invoke(invocation);
    const parsed: DirectiveParseResult = result.ok
      ? parseDirective(result.output)
      : { ok: false, rawOutput: result.output, error: result.error ?? 'head invocation failed' };
    return { result, parsed };
  }
}

export class ClaudeDevelopmentLeadAdapter implements DevelopmentLeadAdapter {
  readonly provider = 'claude' as const;
  readonly displayName = 'claude';
  private readonly claude: ClaudeAdapter;

  constructor(runner: ProcessRunner, config: KairoConfig, repoRoot: string) {
    this.claude = createClaudeAdapter(runner, config, repoRoot); // honors claude.transport
  }

  isAvailable(): Promise<boolean> {
    return this.claude.isAvailable();
  }

  async invoke(invocation: DevLeadInvocation): Promise<ImplementationResult> {
    const result = await this.claude.invoke({
      prompt: invocation.prompt,
      purpose: invocation.purpose,
      ...(invocation.onChunk ? { onChunk: invocation.onChunk } : {}),
    });
    return {
      ok: result.ok,
      transcript: result.transcript,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
