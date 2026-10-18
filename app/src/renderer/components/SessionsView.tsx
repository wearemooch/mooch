// Past chats from every project: grouped by folder, searchable, with a read-only preview and
// "Continue", which opens the chat's folder when it ran somewhere else.
import { ArrowRight, ChatsCircle, FolderOpen, MagnifyingGlass, PencilSimple, Trash, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import type { SessionSummary } from '../../shared/ipc';
import { shortModelName } from '../../shared/modelNames';
import { api, errorMessage } from '../api';
import { useApp } from '../store';
import { applyEvent, emptyTranscript, type TranscriptState } from '../transcript';
import { TranscriptEntries } from './Transcript';

export function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

const samePath = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Oct". */
export function timeAgo(time: number, now = Date.now()): string {
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'yesterday';
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function SessionRow({ session, selected, onSelect }: { session: SessionSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`session-row${selected ? ' active' : ''}`} onClick={onSelect} aria-current={selected}>
      <span className="session-title">{session.title}</span>
      <span className="session-meta">
        {timeAgo(session.updatedAt)} · <span className="mono">{shortModelName(session.model)}</span> · {session.messages} message{session.messages === 1 ? '' : 's'}
      </span>
    </button>
  );
}

export function SessionsView() {
  const open = useApp((s) => s.sessionsOpen);
  const workspace = useApp((s) => s.workspace);
  const currentThread = useApp((s) => s.transcript.threadId);
  const { setSessionsOpen, resumeSession } = useApp.getState();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [preview, setPreview] = useState<TranscriptState>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMatches(null);
    setError(undefined);
    void api.sessions.list().then((list) => {
      setSessions(list);
      setSelectedId((list.find((s) => samePath(s.cwd, workspace)) ?? list[0])?.id);
    });
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setSessionsOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, workspace, setSessionsOpen]);

  // Full-text search runs in the main process over the saved logs; titles match instantly.
  useEffect(() => {
    if (!query.trim()) return setMatches(null);
    const timer = setTimeout(() => void api.sessions.search(query).then((ids) => setMatches(new Set(ids))), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setConfirmDelete(false);
    setRenaming(null);
    if (!selectedId) return setPreview(undefined);
    let cancelled = false;
    void api.sessions.read(selectedId).then((events) => {
      if (!cancelled) setPreview({ ...events.reduce(applyEvent, emptyTranscript), running: false, retrying: undefined });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const groups = useMemo(() => {
    const visible = sessions.filter((s) => !query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase()) || matches?.has(s.id));
    const byFolder = new Map<string, SessionSummary[]>();
    for (const session of visible) byFolder.set(session.cwd, [...(byFolder.get(session.cwd) ?? []), session]);
    // This project's chats first, then the others by their most recent chat.
    return [...byFolder].sort(([a, x], [b, y]) => Number(samePath(b, workspace)) - Number(samePath(a, workspace)) || y[0].updatedAt - x[0].updatedAt);
  }, [sessions, query, matches, workspace]);

  if (!open) return null;
  const selected = sessions.find((s) => s.id === selectedId);
  const elsewhere = selected && !samePath(selected.cwd, workspace);
  const isOpenChat = selected?.id === currentThread;

  const rename = async (title: string) => {
    if (!selected) return;
    const updated = await api.sessions.rename(selected.id, title);
    if (updated) setSessions((list) => list.map((s) => (s.id === updated.id ? updated : s)));
    setRenaming(null);
  };
  const remove = async () => {
    if (!selected) return;
    try {
      await api.sessions.delete(selected.id);
      const rest = sessions.filter((s) => s.id !== selected.id);
      setSessions(rest);
      setSelectedId(rest[0]?.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSessionsOpen(false)}>
      <section className="settings sessions" role="dialog" aria-modal="true" aria-label="Past chats">
        <nav className="settings-nav sessions-nav">
          <h2>Past chats</h2>
          <label className="search">
            <MagnifyingGlass size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all chats" aria-label="Search chats" autoFocus />
          </label>
          <div className="session-list">
            {groups.length === 0 && <p className="muted small">{sessions.length ? 'No chat matches.' : `No saved chats yet. A chat is saved after ${AGENT_NAME}'s first reply.`}</p>}
            {groups.map(([cwd, list]) => (
              <div key={cwd} className="session-group">
                <div className="session-folder" title={cwd}>
                  <FolderOpen size={13} />
                  {folderName(cwd)}
                  {samePath(cwd, workspace) && <span className="muted">· this project</span>}
                </div>
                {list.map((session) => (
                  <SessionRow key={session.id} session={session} selected={session.id === selectedId} onSelect={() => setSelectedId(session.id)} />
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div className="settings-body sessions-body">
          <div className="settings-title">
            {selected && renaming !== null ? (
              <input
                className="rename"
                value={renaming}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename(renaming);
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                onBlur={() => void rename(renaming)}
                aria-label="Chat name"
              />
            ) : (
              <h2 className="session-heading">{selected?.title ?? 'Past chats'}</h2>
            )}
            {selected && renaming === null && (
              <button className="icon-btn" onClick={() => setRenaming(selected.title)} title="Rename" aria-label="Rename">
                <PencilSimple size={14} />
              </button>
            )}
            <span className="spacer" />
            <button className="tab-close" onClick={() => setSessionsOpen(false)} aria-label="Close">
              <X />
            </button>
          </div>
          {selected && (
            <>
              <div className="session-actions">
                <span className="muted small with-icon" title={selected.cwd}>
                  <FolderOpen size={13} />
                  {selected.cwd}
                </span>
                <span className="spacer" />
                {confirmDelete ? (
                  <>
                    <span className="small">Delete this chat for good?</span>
                    <button className="btn small danger" onClick={() => void remove()}>
                      Delete
                    </button>
                    <button className="btn small" onClick={() => setConfirmDelete(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn small" onClick={() => setConfirmDelete(true)} disabled={isOpenChat} title={isOpenChat ? 'This chat is open' : 'Delete this chat'}>
                      <Trash size={14} />
                      Delete
                    </button>
                    <button className="btn primary small" onClick={() => void resumeSession(selected.id)} disabled={isOpenChat}>
                      {isOpenChat ? <ChatsCircle size={14} /> : <ArrowRight size={14} />}
                      {isOpenChat ? 'Open now' : elsewhere ? `Open ${folderName(selected.cwd)} and continue` : 'Continue this chat'}
                    </button>
                  </>
                )}
              </div>
              {error && <p className="notice-inline">{error}</p>}
              <div className="transcript transcript-preview">{preview ? <TranscriptEntries transcript={preview} /> : <p className="muted">Loading…</p>}</div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
