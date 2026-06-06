import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { EventLogger, readEventLog } from '../../src/core/events.js';
import { appendText, readText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('event logger', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    logPath = join(dir, 'agency-log.ndjson');
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('writes one NDJSON line per event', async () => {
    const logger = new EventLogger(logPath);
    await logger.log({ actor: 'kairo', action: 'task_created', status: 'completed', message: 'created' });
    await logger.log({ actor: 'codex', action: 'inspect_repo', status: 'started', message: 'inspecting' });
    const raw = await readText(logPath);
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ actor: 'kairo', action: 'task_created' });
  });

  it('stamps ISO timestamps from the injected clock', async () => {
    const fixed = new Date('2026-06-06T12:00:00.000Z');
    const logger = new EventLogger(logPath, () => fixed);
    const event = await logger.log({ actor: 'user', action: 'decision', status: 'completed', message: 'ok' });
    expect(event.timestamp).toBe('2026-06-06T12:00:00.000Z');
  });

  it('notifies listeners on every event', async () => {
    const logger = new EventLogger(logPath);
    const seen: string[] = [];
    logger.onEvent((e) => seen.push(e.action));
    await logger.log({ actor: 'checks', action: 'run_checks', status: 'completed', message: 'done' });
    expect(seen).toEqual(['run_checks']);
  });

  it('defaults metadata to an empty object', async () => {
    const logger = new EventLogger(logPath);
    const event = await logger.log({ actor: 'kairo', action: 'x', status: 'completed', message: 'm' });
    expect(event.metadata).toEqual({});
  });

  it('reads events back and reports malformed lines without dropping good ones', async () => {
    const logger = new EventLogger(logPath);
    await logger.log({ actor: 'kairo', action: 'a', status: 'completed', message: '1' });
    await appendText(logPath, 'this is not json\n');
    await logger.log({ actor: 'kairo', action: 'b', status: 'completed', message: '2' });
    const { events, malformedLines } = await readEventLog(logPath);
    expect(events.map((e) => e.action)).toEqual(['a', 'b']);
    expect(malformedLines).toEqual([2]);
  });

  it('returns empty for a missing log file', async () => {
    const { events, malformedLines } = await readEventLog(join(dir, 'missing.ndjson'));
    expect(events).toEqual([]);
    expect(malformedLines).toEqual([]);
  });
});
