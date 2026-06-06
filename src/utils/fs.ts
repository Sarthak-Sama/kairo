import { mkdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
}

export async function appendText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, content, 'utf8');
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readText(path);
  return JSON.parse(raw) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + '\n');
}
