import { describe, expect, it } from 'vitest';
import { applyEvent, displayCommand, emptyTranscript, groupForDisplay, isMissingKeyError, markApproval, workSummary, type DisplayItem, type Entry, type TranscriptState } from './transcript';
import type { AgentEvent } from '../shared/ipc';

const run = (events: AgentEvent[], start: TranscriptState = emptyTranscript) => events.reduce(applyEvent, start);

describe('transcript reducer', () => {
  it('streams agent text and keeps the final text on completion', () => {
    const state = run([
      { kind: 'turnStarted', turnId: 't1' },
      { kind: 'agentDelta', itemId: 'a1', delta: 'Hel' },
      { kind: 'agentDelta', itemId: 'a1', delta: 'lo' },
    ]);
    expect(state.running).toBe(true);
    expect(state.entries).toEqual([{ id: 'a1', type: 'agent', text: 'Hello', done: false }]);
    const done = applyEvent(state, {
      kind: 'item',
      phase: 'completed',
      item: { type: 'agentMessage', id: 'a1', text: 'Hello!', phase: null, memoryCitation: null, delivery: null, questions: null },
    });
    expect(done.entries[0]).toEqual({ id: 'a1', type: 'agent', text: 'Hello!', done: true });
  });

  it('appends command output and tracks approvals', () => {
    const state = run([
      {
        kind: 'item',
        phase: 'started',
        item: {
          type: 'commandExecution', id: 'c1', pluginId: null, scriptPath: null, command: 'npm test', cwd: '/w', processId: null,
          source: 'agent' as never, status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      },
      { kind: 'commandOutput', itemId: 'c1', delta: 'ok\n' },
      { kind: 'approval', request: { requestId: 9, type: 'command', itemId: 'c1', command: 'npm test' } },
    ]);
    expect(state.entries[0]).toMatchObject({ type: 'command', output: 'ok\n', status: 'inProgress' });
    const answered = markApproval(state, 9, 'accept');
    expect(answered.entries[1]).toMatchObject({ type: 'approval', resolved: 'accept' });
  });

  it('shows retries as status and final failures as one error entry', () => {
    const state = run([
      { kind: 'turnStarted', turnId: 't1' },
      { kind: 'error', message: 'Reconnecting... 1/5', willRetry: true },
      { kind: 'error', message: 'NVIDIA_NIM_API_KEY is not set.', willRetry: false },
      { kind: 'turnCompleted', turnId: 't1', status: 'failed', error: 'NVIDIA_NIM_API_KEY is not set.' },
    ]);
    expect(state.running).toBe(false);
    expect(state.retrying).toBeUndefined();
    expect(state.entries.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(isMissingKeyError('NVIDIA_NIM_API_KEY is not set.')).toBe(true);
  });

  it('keeps one note per message when a backup model steps in', () => {
    const note: AgentEvent = { kind: 'status', message: 'b stepped in for a, which was busy.', note: true };
    const first = run([note, { kind: 'status', message: 'passing' }, note], { ...emptyTranscript, entries: [{ id: 'u1', type: 'user', text: 'hi' }] });
    expect(first.entries.filter((e) => e.type === 'note')).toHaveLength(1);
    expect(first.retrying).toBe(note.message);
    const second = run([note], { ...first, entries: [...first.entries, { id: 'u2', type: 'user', text: 'again' }] });
    expect(second.entries.filter((e) => e.type === 'note')).toHaveLength(2);
  });
});

describe('displayCommand', () => {
  it('strips the PowerShell wrapper Codex adds on Windows', () => {
    expect(displayCommand(String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'npm test'`)).toBe('npm test');
    expect(displayCommand(String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command ls`)).toBe('ls');
    expect(displayCommand("pwsh.exe -NoProfile -Command 'echo ''hi'''")).toBe("echo 'hi'");
    expect(displayCommand('git status')).toBe('git status');
  });

  it('upserts team events as single entries', () => {
    const council = { id: 'c1', phase: 'planning' as const, judge: 'j', planners: [] };
    const state = run([{ kind: 'council', council }, { kind: 'council', council: { ...council, phase: 'done', merged: 'plan' } }]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ type: 'council', council: { phase: 'done' } });
  });
});

describe('restore points', () => {
  const point = { id: 'p1', label: 'Before: fix', createdAt: 1, reason: 'message' as const, message: 'fix it', canRewind: true };
  it('shows message points, hides pre-restore points, and truncates on rewind', () => {
    const state = run([
      { kind: 'agentDelta', itemId: 'a0', delta: 'earlier' },
      { kind: 'restorePoint', point: { ...point, canRewind: false } },
      { kind: 'restorePoint', point },
      { kind: 'agentDelta', itemId: 'a1', delta: 'later' },
      { kind: 'restorePoint', point: { ...point, id: 'undo', reason: 'restore' } },
    ]);
    expect(state.entries.map((e) => e.type)).toEqual(['agent', 'point', 'agent']);
    expect(state.entries[1]).toMatchObject({ point: { canRewind: true } });

    const rewound = applyEvent(state, { kind: 'restored', result: { pointId: 'p1', files: [], undoPointId: 'undo', rewound: true, message: 'fix it' } });
    expect(rewound.entries.map((e) => e.type)).toEqual(['agent', 'restored']);
    const restored = applyEvent(state, { kind: 'restored', result: { pointId: 'p1', files: [], undoPointId: 'undo', rewound: false } });
    expect(restored.entries.map((e) => e.type)).toEqual(['agent', 'point', 'agent', 'restored']);
  });
});

describe('groupForDisplay', () => {
  const r = (id: string, text = 'hm'): Entry => ({ id, type: 'reasoning', text, done: true });
  const c = (id: string, exitCode: number): Entry => ({ id, type: 'command', command: 'ls', cwd: '.', output: '', status: 'completed', exitCode, durationMs: 1 });
  const msg = (id: string, type: 'user' | 'agent'): Entry => (type === 'user' ? { id, type, text: 'q' } : { id, type, text: 'a', done: true });

  it('folds thinking and commands between messages into one block that keeps its id', () => {
    const approval: Entry = { id: 'ap', type: 'approval', request: { requestId: 1, type: 'command', itemId: 'c9', command: 'npm test' }, resolved: 'accept' };
    const items = groupForDisplay([msg('u', 'user'), r('r1'), c('c1', 1), approval, r('r2'), c('c2', 0), msg('a', 'agent')]);
    expect(items.map((i) => i.kind)).toEqual(['entry', 'work', 'entry']);
    const work = items[1] as Extract<DisplayItem, { kind: 'work' }>;
    expect(work.id).toBe('work-r1');
    expect(work.entries.map((e) => e.id)).toEqual(['r1', 'c1', 'r2', 'c2']);
    expect(workSummary(work.entries)).toBe('Thought · ran 2 commands (1 failed)');
  });

  it('keeps pending approvals and file edits visible between blocks', () => {
    const pending: Entry = { id: 'ap', type: 'approval', request: { requestId: 1, type: 'command', itemId: 'c9', command: 'npm test' } };
    const edit: Entry = { id: 'f', type: 'fileChange', changes: [], status: 'completed' };
    expect(groupForDisplay([r('r1'), pending, c('c1', 0), edit, c('c2', 0)]).map((i) => i.kind)).toEqual(['work', 'entry', 'work', 'entry', 'work']);
  });
});
