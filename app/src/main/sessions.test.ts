import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionSummary } from '../shared/ipc';
import { isSessionId, persistable, SessionRecorder, SessionStore, titleFrom } from './sessions';

const ID = '01a14aa9-3a11-74d0-b028-a024e754ef15';
const userMessage = (text: string): AgentEvent =>
  ({ kind: 'item', phase: 'completed', item: { type: 'userMessage', id: 'u', clientId: null, content: [{ type: 'text', text, text_elements: [] }] } }) as unknown as AgentEvent;

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: ID, title: 'Fix it', cwd: 'D:/p', model: 'm', mode: 'ask', createdAt: 1, updatedAt: 2, messages: 1, ...over };
}

describe('SessionStore', () => {
  it('saves a log and index, reads them back, renames and removes', () => {
    const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'mooch-sessions-')));
    const events: AgentEvent[] = [
      { kind: 'thread', threadId: ID, model: 'm' },
      userMessage('Fix it'),
      { kind: 'codex', state: 'running' },
      { kind: 'status', message: 'passing by' },
      { kind: 'status', message: 'b stepped in for a', note: true },
      { kind: 'turnCompleted', turnId: 't', status: 'completed' },
    ];
    store.save(summary(), events);
    expect(store.list().map((s) => s.id)).toEqual([ID]);
    const read = store.read(ID);
    expect(read.map((e) => e.kind)).toEqual(['thread', 'item', 'status', 'turnCompleted']);
    expect(store.search('STEPPED in')).toEqual([ID]);
    expect(store.search('nowhere to be found')).toEqual([]);
    expect(store.rename(ID, '  Better name  ')?.title).toBe('Better name');
    expect(store.get(ID)?.title).toBe('Better name');
    store.remove(ID);
    expect(store.list()).toEqual([]);
    expect(store.read(ID)).toEqual([]);
  });

  it('lists newest first and survives a torn last line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mooch-sessions-'));
    const store = new SessionStore(dir);
    const other = '01a14aa9-0000-74d0-b028-a024e754ef16';
    store.save(summary({ updatedAt: 1 }), [{ kind: 'thread', threadId: ID, model: 'm' }]);
    store.save(summary({ id: other, updatedAt: 5 }), [{ kind: 'thread', threadId: other, model: 'm' }]);
    expect(store.list().map((s) => s.id)).toEqual([other, ID]);
    writeFileSync(path.join(dir, `${ID}.jsonl`), '{"kind":"thread","threadId":"x","model":"m"}\n{"kind":"turnSta');
    expect(store.read(ID)).toHaveLength(1);
  });

  it('refuses ids that could leave the folder', () => {
    expect(isSessionId('../../etc/passwd')).toBe(false);
    expect(isSessionId('a/b')).toBe(false);
    expect(isSessionId(ID)).toBe(true);
    expect(() => new SessionStore(tmpdir()).read('..\\..\\x')).toThrow();
  });
});

describe('SessionRecorder', () => {
  it('saves a chat once it has a message, titled by the first message', () => {
    vi.useFakeTimers();
    const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'mooch-sessions-')));
    const history: AgentEvent[] = [];
    const recorder = new SessionRecorder(store, () => history, () => ({ cwd: 'D:/proj', mode: 'auto-edit' }), 10);
    const feed = (event: AgentEvent) => {
      history.push(event);
      recorder.onEvent(event);
    };
    feed({ kind: 'thread', threadId: ID, model: 'nemotron' });
    feed({ kind: 'turnCompleted', turnId: 't0', status: 'completed' });
    vi.advanceTimersByTime(50);
    expect(store.list()).toEqual([]); // nothing said yet: not saved
    feed(userMessage('Fix the CORS bug in proxy.js\n\nPlan:\n1. …'));
    feed({ kind: 'turnCompleted', turnId: 't1', status: 'completed' });
    vi.advanceTimersByTime(50);
    expect(store.list()[0]).toMatchObject({ id: ID, title: 'Fix the CORS bug in proxy.js', cwd: 'D:/proj', mode: 'auto-edit', model: 'nemotron', messages: 1 });
    vi.useRealTimers();
  });

  it('keeps a continued chat under its own id and title', () => {
    const store = new SessionStore(mkdtempSync(path.join(tmpdir(), 'mooch-sessions-')));
    const recorder = new SessionRecorder(store, () => [], () => ({ cwd: 'D:/other', mode: 'ask' }), 0);
    recorder.resume(summary({ title: 'Old chat', messages: 3 }));
    recorder.onEvent({ kind: 'thread', threadId: ID, model: 'm' });
    expect(recorder.currentId).toBe(ID);
    recorder.onEvent(userMessage('and one more thing'));
    recorder.onEvent({ kind: 'turnCompleted', turnId: 't', status: 'completed' });
    recorder.flush();
    expect(store.get(ID)).toMatchObject({ title: 'Old chat', messages: 4, cwd: 'D:/p' });
  });
});

describe('helpers', () => {
  it('titles and filters', () => {
    expect(titleFrom('\n  hello there  \nmore')).toBe('hello there');
    expect(titleFrom('x'.repeat(100))).toHaveLength(80);
    expect(titleFrom('   ')).toBe('Untitled chat');
    expect(persistable([{ kind: 'approvalResolved', requestId: 1 }, { kind: 'warning', message: 'w' }]).map((e) => e.kind)).toEqual(['warning']);
  });
});
