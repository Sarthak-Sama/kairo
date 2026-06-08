import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import TextInput from 'ink-text-input';
import { listTaskViews, type TaskView } from '../core/task-view.js';
import { askAction, noteAction, stopAction } from '../core/actions.js';
import { actorTag } from '../renderers/timeline.js';
import type { AgencyEvent } from '../core/events.js';

/**
 * Minimal operator console. Reads the existing artifact model; every
 * mutation goes through the same action functions as the CLI commands.
 * Never auto-approves, never auto-stops, never commits.
 */

interface AppProps {
  repoRoot: string;
  artifactRoot: string;
  initialTaskId?: string;
}

type InputMode = { kind: 'answer' | 'note' | 'stop'; value: string } | null;

function App({ repoRoot, artifactRoot, initialTaskId }: AppProps) {
  const { exit } = useApp();
  const [views, setViews] = useState<TaskView[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>(null);
  const [liveEvents, setLiveEvents] = useState<AgencyEvent[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await listTaskViews(artifactRoot);
      setViews(next);
      setError(null);
    } catch (err) {
      setError(`refresh failed: ${(err as Error).message}`);
    }
  }, [artifactRoot]);

  // Initial load + focus the requested task once.
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);
  useEffect(() => {
    if (initialTaskId && views.length > 0) {
      const index = views.findIndex((v) => v.taskId.includes(initialTaskId));
      if (index >= 0) setSelectedIndex(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views.length > 0]);

  // Auto-refresh every second; cheap (read-only) and flicker-free with Ink.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const selected: TaskView | undefined = views[Math.min(selectedIndex, Math.max(views.length - 1, 0))];

  const runAction = useCallback(
    (label: string, fn: () => Promise<string>) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      setLiveEvents([]);
      void fn()
        .then((message) => setNotice(message))
        .catch((err) => setError((err as Error).message))
        .finally(() => {
          setBusy(null);
          void refresh();
        });
    },
    [refresh],
  );

  const onEvent = useCallback((event: AgencyEvent) => {
    setLiveEvents((prev) => [...prev.slice(-11), event]);
  }, []);

  const submitInput = useCallback(
    (mode: NonNullable<InputMode>) => {
      setInputMode(null);
      if (!selected || !mode.value.trim()) return;
      const taskId = selected.taskId;
      if (mode.kind === 'note') {
        runAction('recording note…', async () => {
          const result = await noteAction(repoRoot, taskId, mode.value);
          return result.stillPending
            ? 'note recorded (task is still waiting — notes do not answer it)'
            : 'note recorded';
        });
      } else if (mode.kind === 'stop') {
        runAction('stopping…', async () => {
          const outcome = await stopAction(repoRoot, taskId, mode.value, { onEvent });
          return outcome.outcome === 'stopped_by_user'
            ? 'task stopped'
            : 'stop requested; active process will be cancelled at the next transport check';
        });
      } else {
        runAction('sending answer…', async () => {
          const result = await askAction(repoRoot, taskId, mode.value, { onEvent });
          if (result.status === 'no-pending') return 'task is not waiting; use note instead';
          if (result.status === 'head-missing') return `head agent unavailable (${result.command})`;
          if (result.status === 'refused') throw new Error(result.error);
          if (result.status === 'done') return `task finished: ${result.outcome.outcome}`;
          return 'nothing sent';
        });
      }
    },
    [selected, repoRoot, runAction, onEvent],
  );

  useInput(
    (input, key) => {
      if (inputMode) return; // TextInput owns the keyboard
      if (input === 'q') {
        exit();
      } else if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex((i) => Math.min(views.length - 1, i + 1));
      } else if (input === 'r') {
        void refresh();
      } else if (input === 'y' && selected && !busy) {
        if (selected.pending?.kind === 'plan_approval') {
          const taskId = selected.taskId;
          runAction('approving plan…', async () => {
            const result = await askAction(repoRoot, taskId, 'y', { onEvent });
            if (result.status === 'done') return `approved — task finished: ${result.outcome.outcome}`;
            if (result.status === 'refused') throw new Error(result.error);
            return 'task is not awaiting plan approval';
          });
        } else {
          setNotice('selected task is not awaiting plan approval');
        }
      } else if (input === 'a' && selected && !busy) {
        if (selected.waitingOnUser) setInputMode({ kind: 'answer', value: '' });
        else setNotice('task is not waiting; use note instead');
      } else if (input === 'n' && selected && !busy) {
        setInputMode({ kind: 'note', value: '' });
      } else if (input === 's' && selected) {
        // Stop is allowed even while an action runs: the control.json signal
        // cancels the in-process run's owned child at the next transport poll.
        setInputMode({ kind: 'stop', value: '' });
      }
    },
    { isActive: true },
  );

  const timeline = busy && liveEvents.length > 0 ? liveEvents : (selected?.recentEvents ?? []);

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" borderStyle="single" width={42} paddingX={1}>
          <Text bold>Tasks ({views.length})</Text>
          {views.length === 0 && <Text dimColor>no tasks yet — kairo run "&lt;task&gt;"</Text>}
          {views.slice(0, 14).map((view, index) => (
            <Text key={view.taskId} inverse={index === selectedIndex}>
              {(view.waitingOnUser ? '! ' : '  ') + view.taskId.slice(0, 26) + '  ' + view.state.slice(0, 12)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="single" flexGrow={1} paddingX={1}>
          {selected ? (
            <>
              <Text bold wrap="truncate">Title: {selected.title}</Text>
              <Text>
                State: {selected.state}
                {selected.outcome ? `  outcome: ${selected.outcome}` : ''}
              </Text>
              <Text>
                Lane: {selected.lane ?? 'none'}  Profile: {selected.profile ?? 'none'}
                {selected.team ? `  Team: head=${selected.team.head} development=${selected.team.developmentLead}` : ''}
              </Text>
              {selected.pending && (
                <Text color="yellow" wrap="truncate-end">
                  Pending:{' '}
                  {selected.pending.kind === 'plan_approval'
                    ? `approve plan (y) or send feedback (a) — ${selected.pending.planPath}`
                    : `answer (a): ${selected.pending.question}`}
                </Text>
              )}
              <Text bold>── Timeline ──</Text>
              {timeline.map((event, index) => (
                <Text key={index} dimColor={event.status === 'skipped'} wrap="truncate-end">
                  {event.timestamp.slice(11, 19)} {actorTag(event)} {event.message}
                </Text>
              ))}
              <Text bold>── Artifacts ──</Text>
              {selected.artifactPaths.map((artifact) => (
                <Text key={artifact.path} wrap="truncate-end">
                  {artifact.label.padEnd(15)} {artifact.path}
                </Text>
              ))}
            </>
          ) : (
            <Text dimColor>no task selected</Text>
          )}
        </Box>
      </Box>
      {inputMode && (
        <Box borderStyle="single" paddingX={1}>
          <Text>
            {inputMode.kind === 'answer' ? 'answer/feedback> ' : inputMode.kind === 'note' ? 'note> ' : 'stop reason> '}
          </Text>
          <TextInput
            value={inputMode.value}
            onChange={(value) => setInputMode({ ...inputMode, value })}
            onSubmit={() => submitInput(inputMode)}
          />
        </Box>
      )}
      <Box paddingX={1}>
        {busy ? (
          <Text color="cyan">Running: {busy}</Text>
        ) : error ? (
          <Text color="red">Error: {error}</Text>
        ) : notice ? (
          <Text color="green">{notice}</Text>
        ) : (
          <Text dimColor>↑/↓ select · y approve · a answer/feedback · n note · s stop · r refresh · q quit</Text>
        )}
      </Box>
    </Box>
  );
}

export async function runTui(repoRoot: string, artifactRoot: string, initialTaskId?: string): Promise<void> {
  const instance = render(
    <App repoRoot={repoRoot} artifactRoot={artifactRoot} {...(initialTaskId ? { initialTaskId } : {})} />,
  );
  await instance.waitUntilExit();
}
