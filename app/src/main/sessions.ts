// Saved chats for the session browser. The engine keeps the model's side of every chat (its own
// rollouts in ~/.mooch/engine); this keeps what the transcript showed, including mooch's own cards
// (reviews, plans, races, restore points, notes): one JSONL event log per chat plus an index.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, ApprovalMode, SessionSummary } from '../shared/ipc';

const ID = /^[A-Za-z0-9-]{8,80}$/;
/** Events that only matter while a chat is live (prompts, engine state, passing status lines). */
const TRANSIENT = new Set<AgentEvent['kind']>(['approval', 'approvalResolved', 'codex', 'modelHealth']);

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/** What is worth keeping from a chat's events. */
export function persistable(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => !TRANSIENT.has(event.kind) && !(event.kind === 'status' && !event.note));
}

/** "Fix the CORS bug in proxy.js" from the first user message (a Deep thinking plan is cut off). */
export function titleFrom(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine || 'Untitled chat';
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

export class SessionStore {
  private readonly indexFile: string;

  constructor(private readonly dir: string) {
    this.indexFile = path.join(dir, 'index.json');
  }

  list(): SessionSummary[] {
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as { sessions?: SessionSummary[] };
      return (parsed.sessions ?? []).filter((s) => isSessionId(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  get(id: string): SessionSummary | undefined {
    return this.list().find((s) => s.id === id);
  }

  read(id: string): AgentEvent[] {
    if (!isSessionId(id)) throw new Error('Invalid session id.');
    let text: string;
    try {
      text = readFileSync(this.logFile(id), 'utf8');
    } catch {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AgentEvent);
      } catch {
        // a torn last line after a crash: keep the rest
      }
    }
    return events;
  }

  /** Ids of chats whose messages, replies or commands contain `query` (case-insensitive). */
  search(query: string): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.list()
      .filter((s) => {
        if (s.title.toLowerCase().includes(needle)) return true;
        try {
          return readFileSync(this.logFile(s.id), 'utf8').toLowerCase().includes(needle);
        } catch {
          return false;
        }
      })
      .map((s) => s.id);
  }

  save(summary: SessionSummary, events: AgentEvent[]): void {
    if (!isSessionId(summary.id)) return;
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.logFile(summary.id), persistable(events).map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.writeIndex([summary, ...this.list().filter((s) => s.id !== summary.id)]);
  }

  rename(id: string, title: string): SessionSummary | undefined {
    const sessions = this.list();
    const session = sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.title = title.trim().slice(0, 120) || session.title;
    this.writeIndex(sessions);
    return session;
  }

  remove(id: string): void {
    if (!isSessionId(id)) return;
    rmSync(this.logFile(id), { force: true });
    this.writeIndex(this.list().filter((s) => s.id !== id));
  }

  private logFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  private writeIndex(sessions: SessionSummary[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.indexFile, JSON.stringify({ version: 1, sessions }, null, 1));
  }
}

/**
 * Follows the live chat's events and saves it after every finished turn (and other lasting changes).
 * Empty chats are never saved.
 */
export class SessionRecorder {
  private current?: SessionSummary;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: SessionStore,
    private readonly history: () => AgentEvent[],
    private readonly context: () => { cwd?: string; mode: ApprovalMode },
    private readonly delayMs = 500,
  ) {}

  /** The chat now open is a saved one being continued. */
  resume(summary: SessionSummary): void {
    this.flush();
    this.current = { ...summary };
  }

  get currentId(): string | undefined {
    return this.current?.id;
  }

  onEvent(event: AgentEvent): void {
    if (event.kind === 'thread') {
      if (this.current?.id === event.threadId) return; // resumed: resume() already set it up
      this.flush();
      const { cwd, mode } = this.context();
      const now = Date.now();
      this.current = cwd ? { id: event.threadId, title: '', cwd, model: event.model, mode, createdAt: now, updatedAt: now, messages: 0 } : undefined;
      return;
    }
    if (!this.current) return;
    if (event.kind === 'item' && event.phase === 'completed' && event.item.type === 'userMessage') {
      this.current.messages++;
      if (!this.current.title) {
        const text = event.item.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');
        this.current.title = titleFrom(text);
      }
    }
    if (['turnCompleted', 'restored', 'review', 'race', 'council', 'restorePoint'].includes(event.kind)) this.schedule();
  }

  /** Writes the pending save now (on quit, or before another chat starts). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, this.delayMs);
  }

  private save(): void {
    if (!this.current || this.current.messages === 0) return;
    this.current.updatedAt = Date.now();
    this.current.title ||= 'Untitled chat';
    try {
      this.store.save({ ...this.current }, this.history());
    } catch {
      // saving is best effort; the engine still has the chat
    }
  }
}

