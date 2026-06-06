import { randomBytes } from 'node:crypto';

/**
 * Build a task ID like `20260606-143012-keyboard-shortcut-modal`.
 * Timestamp prefix keeps task folders sortable; slug keeps them readable.
 */
export function createTaskId(title: string, now: Date = new Date()): string {
  const stamp = formatStamp(now);
  const slug = slugify(title);
  return slug.length > 0 ? `${stamp}-${slug}` : `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function slugify(input: string, maxLength = 40): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
