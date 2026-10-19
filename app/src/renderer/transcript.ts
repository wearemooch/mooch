// Pure reducer that turns the agent event stream into the transcript the panel renders.
import type { AgentEvent, ApprovalDecision, ApprovalRequest, CouncilState, FileUpdateChange, RaceState, RestorePoint, RestoreResult, ReviewState, ThreadItem, ThreadTokenUsage } from '../shared/ipc';

export type Entry =
  | { id: string; type: 'user'; text: string }
  /** `answeredBy`: a backup model wrote this reply because the chat's model was slow. */
  | { id: string; type: 'agent'; text: string; done: boolean; answeredBy?: string }
  | { id: string; type: 'reasoning'; text: string; done: boolean }
  | { id: string; type: 'command'; command: string; cwd: string; output: string; status: string; exitCode: number | null; durationMs: number | null }
  | { id: string; type: 'fileChange'; changes: FileUpdateChange[]; status: string }
  | { id: string; type: 'plan'; text: string }
  | { id: string; type: 'tool'; title: string; status: string; args?: string; result?: string; integration?: boolean }
  | { id: string; type: 'approval'; request: ApprovalRequest; resolved?: ApprovalDecision | 'resolved' }
  | { id: string; type: 'error'; text: string }
  | { id: string; type: 'note'; text: string }
  /**
   * The chat's model couldn't answer. 'switched': the chat moved to `to` (it answered instead).
   * 'unavailable': nothing answered; `to` is a model worth trying.
   */
  | { id: string; type: 'model'; variant: 'switched' | 'unavailable'; from: string; to?: string; why: 'limit' | 'failed' | 'silent' }
  /** A local answer to a slash command (/help, /usage); never sent to the model or saved. */
  | { id: string; type: 'info'; text: string }
  /** The engine summarized everything above; the model only sees the summary from here on. */
  | { id: string; type: 'compaction'; done: boolean }
  | { id: string; type: 'council'; council: CouncilState }
  | { id: string; type: 'review'; review: ReviewState }
  | { id: string; type: 'race'; race: RaceState }
  | { id: string; type: 'point'; point: RestorePoint }
  | { id: string; type: 'restored'; result: RestoreResult; undone?: boolean };

export interface TranscriptState {
  entries: Entry[];
  running: boolean;
  retrying?: string;
  tokenUsage?: ThreadTokenUsage;
  threadId?: string;
  model?: string;
  /** A backup model is answering the current request (not the one the chat asked for). */
  responder?: string;
}

/** The "no model answered" card already explains the turn's failure; its error text would repeat it. */
function explainedByCard(entries: Entry[]): boolean {
  const last = entries.at(-1);
  return last?.type === 'model' && last.variant === 'unavailable';
}

export const emptyTranscript: TranscriptState = { entries: [], running: false };

function upsert(entries: Entry[], next: Entry): Entry[] {
  const index = entries.findIndex((entry) => entry.id === next.id);
  if (index < 0) return [...entries, next];
  const copy = entries.slice();
  copy[index] = next;
  return copy;
}

function update<T extends Entry['type']>(
  entries: Entry[],
  id: string,
  type: T,
  create: () => Extract<Entry, { type: T }>,
  change: (entry: Extract<Entry, { type: T }>) => Extract<Entry, { type: T }>,
): Entry[] {
  const existing = entries.find((entry) => entry.id === id && entry.type === type) as Extract<Entry, { type: T }> | undefined;
  return upsert(entries, change(existing ?? create()));
}

function fromItem(item: ThreadItem, completed: boolean, existing?: Entry): Entry | null {
  switch (item.type) {
    case 'userMessage':
      return {
        id: item.id,
        type: 'user',
        text: item.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n'),
      };
    case 'agentMessage':
      return { id: item.id, type: 'agent', text: item.text || (existing?.type === 'agent' ? existing.text : ''), done: completed };
    case 'reasoning': {
      const text = [...item.summary, ...item.content].join('\n\n');
      return { id: item.id, type: 'reasoning', text: text || (existing?.type === 'reasoning' ? existing.text : ''), done: completed };
    }
    case 'commandExecution':
      return {
        id: item.id,
        type: 'command',
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? (existing?.type === 'command' ? existing.output : ''),
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };
    case 'fileChange':
      return { id: item.id, type: 'fileChange', changes: item.changes, status: item.status };
    case 'plan':
      return { id: item.id, type: 'plan', text: item.text };
    case 'enteredReviewMode':
      return { id: item.id, type: 'note', text: 'Reviewing the uncommitted changes…' };
    case 'exitedReviewMode':
      return { id: item.id, type: 'agent', text: item.review, done: true };
    case 'contextCompaction':
      return { id: item.id, type: 'compaction', done: completed };
    case 'mcpToolCall': {
      const result = item.error?.message ?? item.result?.content.map((part) => ((part as { type?: string }).type === 'text' ? (part as { text: string }).text : `[${(part as { type?: string }).type ?? 'content'}]`)).join('\n');
      const args = item.arguments && typeof item.arguments === 'object' && Object.keys(item.arguments).length ? JSON.stringify(item.arguments, null, 2) : undefined;
      return { id: item.id, type: 'tool', title: `${item.server} · ${item.tool}`, status: item.status, args, result, integration: true };
    }
    case 'dynamicToolCall':
      // mooch's own edit tools already appear as file-change cards.
      if (item.tool === 'edit_file' || item.tool === 'write_file') return null;
      return { id: item.id, type: 'tool', title: item.tool, status: item.status };
    default:
      return null;
  }
}

const MODEL_OUTPUT = new Set<AgentEvent['kind']>(['item', 'agentDelta', 'reasoningDelta', 'commandOutput', 'patchUpdated']);

export function applyEvent(state: TranscriptState, event: AgentEvent): TranscriptState {
  // Once the model produces anything, an earlier "retrying" notice is stale.
  if (state.retrying && MODEL_OUTPUT.has(event.kind)) state = { ...state, retrying: undefined };
  switch (event.kind) {
    case 'thread':
      return { ...emptyTranscript, threadId: event.threadId, model: event.model };
    case 'turnStarted':
      return { ...state, running: true, retrying: undefined, responder: undefined };
    case 'turnCompleted': {
      let entries = state.entries;
      const last = entries.at(-1);
      if (event.status === 'failed' && event.error && !(last?.type === 'error' && last.text === event.error) && !explainedByCard(entries)) {
        entries = [...entries, { id: `error-${event.turnId}`, type: 'error', text: event.error }];
      }
      return { ...state, entries, running: false, retrying: undefined, responder: undefined };
    }
    case 'item': {
      const existing = state.entries.find((entry) => entry.id === event.item.id);
      let entry = fromItem(event.item, event.phase === 'completed', existing);
      if (entry?.type === 'agent' && state.responder) entry = { ...entry, answeredBy: state.responder };
      return entry ? { ...state, entries: upsert(state.entries, entry) } : state;
    }
    case 'responder':
      return { ...state, responder: event.model === event.requested ? undefined : event.model };
    case 'modelSwitched':
      return {
        ...state,
        model: event.to,
        // The reply in progress already comes from the new model, so it needs no "answered by".
        responder: undefined,
        entries: [...state.entries, { id: `model-${state.entries.length}`, type: 'model', variant: 'switched', from: event.from, to: event.to, why: event.why }],
      };
    case 'modelUnavailable':
      return {
        ...state,
        retrying: undefined,
        entries: [...state.entries, { id: `model-${state.entries.length}`, type: 'model', variant: 'unavailable', from: event.model, to: event.alternative, why: event.why }],
      };
    case 'agentDelta':
      return {
        ...state,
        entries: update(state.entries, event.itemId, 'agent', () => ({ id: event.itemId, type: 'agent', text: '', done: false }), (e) => ({ ...e, text: e.text + event.delta })),
      };
    case 'reasoningDelta':
      return {
        ...state,
        entries: update(state.entries, event.itemId, 'reasoning', () => ({ id: event.itemId, type: 'reasoning', text: '', done: false }), (e) => ({ ...e, text: e.text + event.delta })),
      };
    case 'commandOutput':
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === event.itemId && e.type === 'command' ? { ...e, output: e.output + event.delta } : e)),
      };
    case 'patchUpdated':
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === event.itemId && e.type === 'fileChange' ? { ...e, changes: event.changes } : e)),
      };
    case 'approval':
      return { ...state, entries: [...state.entries, { id: `approval-${event.request.requestId}`, type: 'approval', request: event.request }] };
    case 'approvalResolved':
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.type === 'approval' && e.request.requestId === event.requestId && !e.resolved ? { ...e, resolved: 'resolved' } : e,
        ),
      };
    case 'error':
      if (event.willRetry) return { ...state, retrying: event.message };
      if (explainedByCard(state.entries)) return { ...state, retrying: undefined };
      return { ...state, retrying: undefined, entries: [...state.entries, { id: `error-${state.entries.length}-${Date.now()}`, type: 'error', text: event.message }] };
    case 'tokenUsage':
      return { ...state, tokenUsage: event.usage };
    case 'status': {
      if (!event.note) return { ...state, retrying: event.message };
      // One note per message and text: a turn makes many model requests, and each may switch.
      const lastUser = [...state.entries].reverse().find((e) => e.type === 'user')?.id ?? 'start';
      return { ...state, retrying: event.message, entries: upsert(state.entries, { id: `note-${lastUser}-${event.message}`, type: 'note', text: event.message }) };
    }
    case 'council':
      return { ...state, entries: upsert(state.entries, { id: `council-${event.council.id}`, type: 'council', council: event.council }) };
    case 'review':
      return { ...state, entries: upsert(state.entries, { id: `review-${event.review.id}`, type: 'review', review: event.review }) };
    case 'race':
      return { ...state, entries: upsert(state.entries, { id: `race-${event.race.id}`, type: 'race', race: event.race }) };
    case 'restorePoint':
      // Points taken just before a restore are reached through the restore card's Undo, not shown as rows.
      if (event.point.reason === 'restore') return state;
      return { ...state, entries: upsert(state.entries, { id: `point-${event.point.id}`, type: 'point', point: event.point }) };
    case 'restored': {
      let entries = state.entries;
      if (event.result.rewound) {
        // The conversation was cut back: drop the message the point was taken before and everything after it.
        const at = entries.findIndex((e) => e.type === 'point' && e.point.id === event.result.pointId);
        if (at >= 0) entries = entries.slice(0, at);
      }
      return { ...state, running: false, entries: [...entries, { id: `restored-${event.result.undoPointId}`, type: 'restored', result: event.result }] };
    }
    case 'codex':
      if (event.state === 'stopped') return { ...state, running: false };
      return state;
    default:
      return state;
  }
}

/** Marks an approval as answered locally, before Codex confirms. */
export function markApproval(state: TranscriptState, requestId: string | number, decision: ApprovalDecision): TranscriptState {
  return {
    ...state,
    entries: state.entries.map((e) => (e.type === 'approval' && e.request.requestId === requestId ? { ...e, resolved: decision } : e)),
  };
}

export { displayCommand } from '../shared/commands';

/** Recognizes FCC's "provider key missing" errors so the UI can offer the settings button. */
export function isMissingKeyError(text: string): boolean {
  return /API_KEY is not set|Add it in the Admin UI/i.test(text);
}

/** Steps of the agent's work that fold into one collapsible block between messages. */
const WORK_TYPES = new Set<Entry['type']>(['reasoning', 'command', 'tool', 'plan']);

export type DisplayItem = { kind: 'entry'; entry: Entry } | { kind: 'work'; id: string; entries: Entry[] };

/**
 * Groups consecutive work steps (thinking, commands, tool calls, plans) into one block, like Claude
 * Code's collapsed tool calls. Answered approvals render nothing, so they don't split a block; pending
 * approvals, file edits, messages and everything else stay visible on their own. The block keeps the id
 * of its first step, so its open/closed state survives while it grows.
 */
export function groupForDisplay(entries: Entry[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let work: Extract<DisplayItem, { kind: 'work' }> | undefined;
  for (const entry of entries) {
    if (entry.type === 'approval' && entry.resolved) continue;
    if (WORK_TYPES.has(entry.type)) {
      if (!work) {
        work = { kind: 'work', id: `work-${entry.id}`, entries: [] };
        items.push(work);
      }
      work.entries.push(entry);
    } else {
      work = undefined;
      items.push({ kind: 'entry', entry });
    }
  }
  return items;
}

/** One line for a closed work block, e.g. "Thought · ran 3 commands (1 failed)". */
export function workSummary(entries: Entry[]): string {
  const parts: string[] = [];
  if (entries.some((e) => e.type === 'reasoning' && e.text)) parts.push('Thought');
  const commands = entries.filter((e): e is Extract<Entry, { type: 'command' }> => e.type === 'command');
  if (commands.length) {
    const failed = commands.filter((c) => c.status === 'failed' || (c.exitCode !== null && c.exitCode !== 0)).length;
    parts.push(`ran ${commands.length} command${commands.length === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`);
  }
  const tools = entries.filter((e) => e.type === 'tool').length;
  if (tools) parts.push(`used ${tools} tool${tools === 1 ? '' : 's'}`);
  if (entries.some((e) => e.type === 'plan')) parts.push('updated the plan');
  const text = parts.join(' · ');
  return text ? text[0].toUpperCase() + text.slice(1) : 'Worked';
}

/** Adds a local info card (the answer to /help, /usage…) at the end of the transcript. */
export function addInfo(state: TranscriptState, text: string): TranscriptState {
  return { ...state, entries: [...state.entries, { id: `info-${Date.now()}-${state.entries.length}`, type: 'info', text }] };
}
