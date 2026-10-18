// Sits between the agent and the window. Streaming deltas are merged and sent at most every
// `flushMs`, instead of one IPC message (and one React render) per token or output chunk. It also
// keeps the current chat's events, so a reloaded or recovered window can rebuild its transcript.
import type { AgentEvent } from '../shared/ipc';

type DeltaEvent = Extract<AgentEvent, { kind: 'agentDelta' | 'reasoningDelta' | 'commandOutput' }>;

const MAX_HISTORY = 20_000;

function isDelta(event: AgentEvent): event is DeltaEvent {
  return event.kind === 'agentDelta' || event.kind === 'reasoningDelta' || event.kind === 'commandOutput';
}

/** Appends `event` to `list`, merging it into the last entry when both are deltas of the same item. */
function appendMerged(list: AgentEvent[], event: AgentEvent): void {
  const last = list.at(-1);
  if (last && isDelta(last) && isDelta(event) && last.kind === event.kind && last.itemId === event.itemId) {
    list[list.length - 1] = { ...last, delta: last.delta + event.delta };
  } else {
    list.push(event);
  }
}

export class AgentEventStream {
  private pending: AgentEvent[] = [];
  private timer?: NodeJS.Timeout;
  private recorded: AgentEvent[] = [];
  private full = false;

  constructor(
    private readonly deliver: (event: AgentEvent) => void,
    private readonly flushMs = 40,
  ) {}

  push(event: AgentEvent): void {
    if (event.kind === 'thread') {
      // A new chat: the window starts an empty transcript too.
      this.flush();
      this.recorded = [];
      this.full = false;
    }
    appendMerged(this.pending, event);
    if (!isDelta(event)) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.pending;
    this.pending = [];
    for (const event of events) {
      this.record(event);
      this.deliver(event);
    }
  }

  /** Everything since the current chat started, deltas merged. */
  history(): AgentEvent[] {
    this.flush();
    return [...this.recorded];
  }

  /** Replaces the kept history (a saved chat being continued), without sending anything to the window. */
  replaceHistory(events: AgentEvent[]): void {
    this.flush();
    this.recorded = events.slice(0, MAX_HISTORY);
    this.full = events.length >= MAX_HISTORY;
  }

  private record(event: AgentEvent): void {
    if (this.full) return;
    appendMerged(this.recorded, event);
    if (this.recorded.length >= MAX_HISTORY) {
      this.full = true;
      this.recorded.push({ kind: 'warning', message: 'This chat is too long to restore completely after a window reload.' });
    }
  }
}
