import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { ChecksRun, CheckResult } from './checks.js';
import { fileExists, readJson, readText } from '../utils/fs.js';

/** One implementation phase as the orchestrator tracks it. */
export interface PhaseRecord {
  phase: number;
  claudeReport: string;
  checksRun: ChecksRun | null;
  changedFiles: string[];
  review: string;
  /** Risk level Codex declared on the directive that drove this phase. */
  directiveRisk: 'low' | 'medium' | 'high';
  /** Risk level Codex declared on its review directive (null until reviewed). */
  reviewRisk: 'low' | 'medium' | 'high' | null;
  diffAvailable: boolean;
  diffNote?: string;
}

/**
 * Rebuild phase records from the artifact folders of a paused task so a
 * resumed run has enough context for Codex follow-ups, risk accounting, and
 * the final report. Missing artifacts become visible placeholders — they
 * never crash the resume.
 */
export async function reconstructPhases(taskDir: string): Promise<PhaseRecord[]> {
  let entries: string[] = [];
  try {
    entries = (await readdir(taskDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^phase-\d{3}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const phases: PhaseRecord[] = [];
  for (const name of entries) {
    const phaseDir = join(taskDir, name);
    const phaseNumber = Number(name.slice('phase-'.length));

    const directive = await readJsonSafe<{ risk?: string }>(join(phaseDir, 'codex-directive.json'));
    const decision = await readJsonSafe<{ risk?: string }>(join(phaseDir, 'codex-decision.json'));

    // Implementer report: Claude's report, or the Codex self-edit transcript.
    let claudeReport = await readTextSafe(join(phaseDir, 'claude-report.md'));
    if (claudeReport === null) {
      const selfEdit = await readTextSafe(join(phaseDir, 'codex-self-edit-transcript.md'));
      claudeReport = selfEdit !== null ? `(Codex self-edit — no Claude involvement)\n\n${selfEdit}` : null;
    }

    const review = await readTextSafe(join(phaseDir, 'codex-review.md'));
    const diff = await readTextSafe(join(phaseDir, 'diff.patch'));
    const checkResults = await readJsonSafe<CheckResult[]>(join(phaseDir, 'checks.json'));

    phases.push({
      phase: phaseNumber,
      claudeReport: claudeReport ?? '(artifact missing: no implementer report found for this phase)',
      checksRun: checkResults ? rebuildChecksRun(checkResults) : null,
      changedFiles: diff !== null ? changedFilesFromPatch(diff) : [],
      review: review ?? '(artifact missing: no review recorded for this phase)',
      directiveRisk: normalizeRisk(directive?.risk, 'medium'),
      reviewRisk: decision?.risk !== undefined ? normalizeRisk(decision.risk, 'medium') : null,
      diffAvailable: diff !== null && !diff.startsWith('# '),
      ...(diff === null ? { diffNote: 'diff.patch missing from phase artifacts' } : {}),
    });
  }
  return phases;
}

/** Recover the changed-file list from the stored patch's `diff --git` headers. */
export function changedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) files.add(match[2]!);
  }
  return [...files];
}

function rebuildChecksRun(results: CheckResult[]): ChecksRun {
  const count = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
  return {
    results,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    blocked: count('blocked'),
    allPassedOrSkipped: count('failed') === 0 && count('blocked') === 0,
    log: '(reconstructed from checks.json)',
    unknownOnlyNames: [],
  };
}

function normalizeRisk(value: string | undefined, fallback: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : fallback;
}

async function readTextSafe(path: string): Promise<string | null> {
  return (await fileExists(path)) ? readText(path) : null;
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  if (!(await fileExists(path))) return null;
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}
