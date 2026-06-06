import fg from 'fast-glob';
import { extname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { fileExists, readText } from '../utils/fs.js';
import type { KairoConfig } from './config.js';

export interface RepoScan {
  fileCount: number;
  files: string[];
  byExtension: Record<string, number>;
  topLevelDirs: string[];
  packageJson: { name?: string; scripts?: Record<string, string> } | null;
  markdown: string;
}

const FILE_LIST_CAP = 400;

/**
 * Cheap, read-only repo survey. The output (repo-scan.md) is what Codex gets
 * as orientation before it inspects deeper itself.
 */
export async function scanRepo(repoRoot: string, config: KairoConfig): Promise<RepoScan> {
  const files = await fg('**/*', {
    cwd: repoRoot,
    ignore: config.scanner.exclude,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  files.sort();

  const byExtension: Record<string, number> = {};
  const topLevel = new Set<string>();
  for (const file of files) {
    const ext = extname(file) || '(no ext)';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    const slash = file.indexOf('/');
    if (slash > 0) topLevel.add(file.slice(0, slash) + '/');
  }

  let packageJson: RepoScan['packageJson'] = null;
  const pkgPath = join(repoRoot, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const raw = JSON.parse(await readText(pkgPath)) as Record<string, unknown>;
      packageJson = {
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        ...(raw.scripts && typeof raw.scripts === 'object'
          ? { scripts: raw.scripts as Record<string, string> }
          : {}),
      };
    } catch {
      packageJson = null;
    }
  }

  const scan: RepoScan = {
    fileCount: files.length,
    files,
    byExtension,
    topLevelDirs: [...topLevel].sort(),
    packageJson,
    markdown: '',
  };
  scan.markdown = await renderScanMarkdown(repoRoot, scan);
  return scan;
}

async function renderScanMarkdown(repoRoot: string, scan: RepoScan): Promise<string> {
  const lines: string[] = [];
  lines.push('# Repo Scan');
  lines.push('');
  lines.push(`- Root: ${repoRoot}`);
  lines.push(`- Files (after excludes): ${scan.fileCount}`);
  const gitDir = join(repoRoot, '.git');
  let isGit = false;
  try {
    isGit = (await stat(gitDir)).isDirectory();
  } catch {
    isGit = false;
  }
  lines.push(`- Git repository: ${isGit ? 'yes' : 'no'}`);
  if (scan.packageJson?.name) {
    lines.push(`- Package: ${scan.packageJson.name}`);
  }
  lines.push('');

  lines.push('## Top-level directories');
  lines.push('');
  if (scan.topLevelDirs.length === 0) {
    lines.push('(none — flat or empty repo)');
  } else {
    for (const dir of scan.topLevelDirs) lines.push(`- ${dir}`);
  }
  lines.push('');

  lines.push('## Files by extension');
  lines.push('');
  const sortedExts = Object.entries(scan.byExtension).sort((a, b) => b[1] - a[1]);
  for (const [ext, count] of sortedExts.slice(0, 20)) {
    lines.push(`- ${ext}: ${count}`);
  }
  lines.push('');

  if (scan.packageJson?.scripts) {
    lines.push('## package.json scripts');
    lines.push('');
    for (const [name, cmd] of Object.entries(scan.packageJson.scripts)) {
      lines.push(`- \`${name}\`: \`${cmd}\``);
    }
    lines.push('');
  }

  lines.push('## File list');
  lines.push('');
  const shown = scan.files.slice(0, FILE_LIST_CAP);
  for (const file of shown) lines.push(`- ${file}`);
  if (scan.files.length > FILE_LIST_CAP) {
    lines.push(`- … and ${scan.files.length - FILE_LIST_CAP} more (truncated)`);
  }
  lines.push('');
  return lines.join('\n');
}
