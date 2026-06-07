import { z } from 'zod';
import { join } from 'node:path';
import { fileExists, readJson, writeJson } from '../utils/fs.js';

export const CheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

export const AgentProviderSchema = z.enum(['codex', 'claude']);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const TeamRolesSchema = z.object({
  head: AgentProviderSchema,
  developmentLead: AgentProviderSchema,
});
export type TeamRoles = z.infer<typeof TeamRolesSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    artifactDir: z.string().default('.kairo'),
    /** Which provider fills each agency role. Defaults preserve the original team. */
    roles: z
      .object({
        head: AgentProviderSchema.default('codex'),
        developmentLead: AgentProviderSchema.default('claude'),
      })
      .default({}),
    /**
     * User-defined operating profiles — arbitrary names chosen by the user
     * (e.g. "daily", "review-heavy"). Kairo attaches no meaning to the names.
     */
    profiles: z.record(z.string().min(1, 'profile names must be non-empty'), TeamRolesSchema).default({}),
    /** Profile used when `--profile` is not passed; must exist in `profiles`. */
    defaultProfile: z.string().nullable().default(null),
  limits: z
    .object({
      maxPhases: z.number().int().positive().default(6),
      maxRevisionLoopsPerPhase: z.number().int().positive().default(3),
      maxTotalModelCalls: z.number().int().positive().default(20),
      maxRuntimeMinutes: z.number().int().positive().default(90),
    })
    .default({}),
  codex: z
    .object({
      command: z.string().default('codex'),
      model: z.string().nullable().default(null),
      sandbox: z.string().default('workspace-write'),
    })
    .default({}),
  claude: z
    .object({
      command: z.string().default('claude'),
      model: z.string().default('sonnet'),
      permissionMode: z.string().default('auto'),
      /** Permission mode when Claude acts as HEAD (planning/review/decisions). */
      headPermissionMode: z.string().default('plan'),
      /** "print" = proven `claude -p` subprocess (default); "pty" = opt-in PTY transport. */
      transport: z.enum(['print', 'pty']).default('print'),
    })
    .default({}),
  checks: z.array(CheckSchema).default([]),
    scanner: z
      .object({
        exclude: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    if (config.defaultProfile !== null && !(config.defaultProfile in config.profiles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultProfile'],
        message: `defaultProfile "${config.defaultProfile}" does not exist in profiles (configured: ${Object.keys(config.profiles).join(', ') || 'none'})`,
      });
    }
  });

/** The team configuration resolved for one run. */
export interface ResolvedTeam {
  profile: string | null;
  head: AgentProvider;
  developmentLead: AgentProvider;
}

/**
 * Resolution order: explicit `--profile` > `defaultProfile` > `roles`
 * (which itself defaults to the original codex-head/claude-dev team).
 */
export function resolveTeam(config: KairoConfig, explicitProfile?: string): ResolvedTeam {
  if (explicitProfile !== undefined) {
    const profile = config.profiles[explicitProfile];
    if (!profile) {
      throw new ConfigError(
        `unknown profile "${explicitProfile}" — configured profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`,
      );
    }
    return { profile: explicitProfile, ...profile };
  }
  if (config.defaultProfile !== null) {
    // Validated by the schema to exist.
    const profile = config.profiles[config.defaultProfile]!;
    return { profile: config.defaultProfile, ...profile };
  }
  return { profile: null, head: config.roles.head, developmentLead: config.roles.developmentLead };
}

export type KairoConfig = z.infer<typeof ConfigSchema>;
export type CheckConfig = z.infer<typeof CheckSchema>;

export const DEFAULT_CONFIG: KairoConfig = {
  version: 1,
  artifactDir: '.kairo',
  roles: {
    head: 'codex',
    developmentLead: 'claude',
  },
  profiles: {},
  defaultProfile: null,
  limits: {
    maxPhases: 6,
    maxRevisionLoopsPerPhase: 3,
    maxTotalModelCalls: 20,
    maxRuntimeMinutes: 90,
  },
  codex: {
    command: 'codex',
    model: null,
    sandbox: 'workspace-write',
  },
  claude: {
    command: 'claude',
    model: 'sonnet',
    permissionMode: 'auto',
    headPermissionMode: 'plan',
    transport: 'print',
  },
  checks: [
    { name: 'typecheck', command: 'pnpm typecheck' },
    { name: 'lint', command: 'pnpm lint' },
    { name: 'test', command: 'pnpm test' },
    { name: 'build', command: 'pnpm build' },
  ],
  scanner: {
    exclude: [
      '.git/**',
      '.kairo/**',
      'node_modules/**',
      'dist/**',
      'build/**',
      '.next/**',
      'coverage/**',
    ],
  },
};

export function configPath(repoRoot: string): string {
  return join(repoRoot, '.kairo', 'config.json');
}

export async function configExists(repoRoot: string): Promise<boolean> {
  return fileExists(configPath(repoRoot));
}

export async function loadConfig(repoRoot: string): Promise<KairoConfig> {
  const path = configPath(repoRoot);
  if (!(await fileExists(path))) {
    throw new ConfigError(`No Kairo config found at ${path}. Run \`kairo init\` first.`);
  }
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Config at ${path} failed validation:\n${issues}`);
  }
  return parsed.data;
}

export async function writeDefaultConfig(repoRoot: string): Promise<string> {
  const path = configPath(repoRoot);
  await writeJson(path, DEFAULT_CONFIG);
  return path;
}

export class ConfigError extends Error {}
