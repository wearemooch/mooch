import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../shared/ipc';
import { OutputLimiter } from './codex/outputLimit';
import { AgentEventStream } from './eventStream';

describe('AgentEventStream', () => {
  it('merges deltas of the same item and keeps order around other events', () => {
    const sent: AgentEvent[] = [];
    const stream = new AgentEventStream((e) => sent.push(e), 10_000);
    stream.push({ kind: 'commandOutput', itemId: 'c', delta: 'a' });
    stream.push({ kind: 'commandOutput', itemId: 'c', delta: 'b' });
    stream.push({ kind: 'agentDelta', itemId: 'm', delta: 'hi' });
    expect(sent).toEqual([]); // still waiting for the timer
    stream.push({ kind: 'turnCompleted', turnId: 't', status: 'completed' } as AgentEvent);
    expect(sent.map((e) => e.kind)).toEqual(['commandOutput', 'agentDelta', 'turnCompleted']);
    expect(sent[0]).toMatchObject({ delta: 'ab' });
  });

  it('keeps the current chat for a reloaded window and starts over on a new thread', () => {
    const stream = new AgentEventStream(() => {}, 10_000);
    stream.push({ kind: 'thread', threadId: 'one', model: 'm' });
    stream.push({ kind: 'agentDelta', itemId: 'x', delta: 'old' });
    stream.push({ kind: 'thread', threadId: 'two', model: 'm' });
    stream.push({ kind: 'agentDelta', itemId: 'y', delta: 'new ' });
    stream.push({ kind: 'agentDelta', itemId: 'y', delta: 'text' });
    expect(stream.history()).toEqual([
      { kind: 'thread', threadId: 'two', model: 'm' },
      { kind: 'agentDelta', itemId: 'y', delta: 'new text' },
    ]);
  });
});

describe('OutputLimiter', () => {
  it('passes output through until the limit, then cuts once and drops the rest', () => {
    const limiter = new OutputLimiter(10);
    expect(limiter.delta('c', '12345')).toBe('12345');
    expect(limiter.delta('c', '67890abc')).toMatch(/^67890\n… output truncated/);
    expect(limiter.delta('c', 'more')).toBeNull();
    expect(limiter.delta('other', 'ok')).toBe('ok');
    expect(limiter.whole('big', 'x'.repeat(50))).toMatch(/^x{10}\n… output truncated/);
  });
});
