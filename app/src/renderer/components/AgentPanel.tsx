import { ArrowDown, ArrowUp, ChatsCircle, FlagCheckered, Hand, HourglassMedium, Lightning, NotePencil, RocketLaunch, Stop, X, type Icon } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import type { ApprovalMode } from '../../shared/ipc';
import { groupByProvider, modelLabel, shortModelName } from '../../shared/modelNames';
import { useApp } from '../store';
import { matchCommands, type SlashCommand } from '../slashCommands';
import { CommandMenu } from './CommandMenu';
import { TeamBar } from './TeamBar';
import { TranscriptEntries } from './Transcript';

const MODES: { value: ApprovalMode; label: string; hint: string; icon: Icon }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Reads freely; asks before any edit or command that writes', icon: Hand },
  { value: 'auto-edit', label: 'Auto-edit', hint: 'Edits the workspace freely, asks for anything riskier', icon: Lightning },
  { value: 'full-auto', label: 'Full auto', hint: 'Never asks. No sandbox.', icon: RocketLaunch },
];


/** "Working…", or how long the model has been silent once it's been more than a few seconds. */
function useWorkingLabel(running: boolean, lastActivity: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const silent = Math.round((now - lastActivity) / 1000);
  return silent >= 5 ? `Waiting for the model… ${silent}s` : 'Working…';
}

/** Races run unattended with Full auto's authority, so outside Full auto the user says yes first. */
function RaceConsentCard({ testCommand }: { testCommand?: string }) {
  const { confirmRace, cancelRace } = useApp.getState();
  return (
    <div className="card race-consent" role="alertdialog" aria-label="Start a race?">
      <div className="card-title">Race without asking?</div>
      <p className="muted">
        Each agent edits its own copy of the project and runs commands there without asking you
        {testCommand ? (
          <>
            , and then mooch runs <code>{testCommand}</code> in every copy
          </>
        ) : null}
        . That code runs as you, not in a sandbox, so only race projects you trust.
      </p>
      <div className="actions">
        <button className="btn primary small" onClick={() => void confirmRace()}>
          <FlagCheckered />
          Start race
        </button>
        <button className="btn small" onClick={cancelRace}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AgentPanel() {
  const { models, model, mode, transcript, codex, codexMessage, notice, fcc, workspace, lastActivity, busyUntil, raceConsent, modelFlash } = useApp();
  const isBusy = (slug: string) => (busyUntil[slug] ?? 0) > Date.now();
  const silenceLabel = useWorkingLabel(transcript.running, lastActivity);
  const awaitingYou = transcript.entries.some((e) => e.type === 'approval' && !e.resolved);
  const workingLabel = awaitingYou ? 'Waiting for your answer above' : silenceLabel;
  const { setModel, setMode, newChat, send, stop, setNotice, race } = useApp.getState();
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const draftRequest = useApp((s) => s.draftRequest);
  useEffect(() => {
    // After a rewind, the message comes back to the input box to edit and resend.
    if (draftRequest !== undefined) {
      setDraft(draftRequest);
      useApp.setState({ draftRequest: undefined });
    }
  }, [draftRequest]);

  // Follow new output only while the reader is at the bottom. Scrolling up to read stops the following;
  // scrolling back down (or "Jump to latest", or sending a message) resumes it.
  const following = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const scrollToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    following.current = true;
    setScrolledUp(false);
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    following.current = atBottom;
    setScrolledUp(!atBottom);
  };
  useLayoutEffect(() => {
    if (following.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [transcript.entries]);

  const ready = fcc.state === 'running' && !!workspace && !!model;
  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0];
  // The / menu: open while the message is just "/partial" (no space yet) and not dismissed with Esc.
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuOpen = draft.startsWith('/') && !/\s/.test(draft) && !menuDismissed;
  const menuMatches = menuOpen ? matchCommands(useApp.getState().commands(), draft.slice(1)) : [];
  useEffect(() => {
    if (draft === '/') void useApp.getState().loadCommands();
    setMenuIndex(0);
    if (!draft.startsWith('/')) setMenuDismissed(false);
  }, [draft]);

  const runCommand = async (text: string) => {
    if (transcript.running && !/^\/(help|usage|resume|theme|commands|model|mode)\b/i.test(text)) {
      setNotice(`Wait for ${AGENT_NAME} to finish (or press Stop) before running that.`);
      return;
    }
    scrollToEnd();
    const result = await useApp.getState().runCommand(text);
    if (result === 'ran') setDraft((current) => (current === text ? '' : current));
  };
  const pick = (command: SlashCommand) => {
    if (command.args) setDraft(`/${command.name} `);
    else {
      setDraft('');
      void runCommand(`/${command.name}`);
    }
  };
  const submit = () => {
    // A message that starts with "/" is a command; start with a space to send "/…" as a message.
    if (draft.startsWith('/')) {
      if (ready || /^\/(help|resume|theme|commands)\b/i.test(draft)) void runCommand(draft.trim());
      return;
    }
    const text = draft.trim();
    if (!text || transcript.running || !ready) return;
    setDraft('');
    scrollToEnd();
    void send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (menuMatches.length ? (i + step + menuMatches.length) % menuMatches.length : 0));
        return;
      }
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && menuMatches[menuIndex]) {
        event.preventDefault();
        pick(menuMatches[menuIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <aside className="agent-panel" aria-label={AGENT_NAME}>
      <div className="agent-head">
        <span className="agent-name">{AGENT_NAME}</span>
        {/* Remounted when the chat switches models by itself, so the highlight plays once. */}
        <select key={modelFlash ?? 'model'} className={modelFlash ? 'model-flash' : undefined} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" title="Switches from your next message">
          {models.length === 0 && <option value="">No models yet</option>}
          {groupByProvider(models).map((group) => (
            <optgroup key={group.provider} label={group.provider}>
              {group.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {shortModelName(m.slug)}
                  {isBusy(m.slug) ? ' · busy' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="select-with-icon" title={currentMode.hint}>
          <currentMode.icon size={14} />
          <select value={mode} onChange={(e) => setMode(e.target.value as ApprovalMode)} aria-label="Permissions">
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn icon-only" onClick={() => useApp.getState().setSessionsOpen(true)} title="Past chats" aria-label="Past chats">
          <ChatsCircle />
        </button>
        <button className="btn" onClick={() => void newChat()} disabled={!ready || transcript.running} title="Start a new chat with the selected model and permissions">
          <NotePencil />
          New chat
        </button>
      </div>

      <TeamBar />

      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {transcript.entries.length === 0 && (
          <div className="empty-chat">
            <p>{workspace ? `Tell ${AGENT_NAME} what to change, or ask about this project.` : `Open a folder and tell ${AGENT_NAME} what to change.`}</p>
            {transcript.model && <p className="muted mono">{modelLabel(transcript.model)}</p>}
          </div>
        )}
        <TranscriptEntries transcript={transcript} />
        {scrolledUp && (
          <button className="btn jump-latest" onClick={scrollToEnd}>
            <ArrowDown size={14} />
            {transcript.running ? 'Jump to latest' : 'Back to the end'}
          </button>
        )}
      </div>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="tab-close" onClick={() => setNotice(undefined)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      {codex === 'stopped' && codexMessage && transcript.threadId && <div className="notice">{codexMessage}</div>}

      {raceConsent && <RaceConsentCard testCommand={raceConsent.testCommand} />}
      <div className="composer">
        {menuOpen && <CommandMenu commands={menuMatches} index={menuIndex} onPick={pick} onHover={setMenuIndex} />}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={ready ? `Ask ${AGENT_NAME} to change something…  (Enter to send, / for commands)` : 'Waiting for a folder and a model…'}
          rows={3}
          disabled={!ready}
        />
        <div className="composer-foot">
          <span className="muted with-icon">
            {transcript.running && workingLabel !== 'Working…' && <HourglassMedium size={14} />}
            {transcript.retrying ?? (transcript.running ? workingLabel : '')}
          </span>
          {transcript.running ? (
            <button className="btn danger" onClick={() => void stop()}>
              <Stop weight="fill" />
              Stop
            </button>
          ) : (
            <div className="actions tight">
              <button
                className="btn"
                onClick={() => {
                  const text = draft.trim();
                  if (!text || !ready) return;
                  setDraft('');
                  scrollToEnd();
                  void race(text);
                }}
                disabled={!ready || !draft.trim()}
                title="Several agents solve this in separate copies; the project's tests pick the winner"
              >
                <FlagCheckered />
                Race
              </button>
              <button className="btn primary" onClick={submit} disabled={!ready || !draft.trim()}>
                <ArrowUp weight="bold" />
                Send
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
