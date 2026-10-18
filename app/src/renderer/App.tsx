import { ArrowClockwise, ChatsCircle, Coins, FolderOpen, GearSix } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '../shared/ipc';
import { AGENT_NAME, APP_NAME, TAGLINE } from '../shared/brand';
import { providerName, shortModelName } from '../shared/modelNames';
import { api } from './api';
import { AgentPanel } from './components/AgentPanel';
import { EditorArea } from './components/EditorArea';
import { FileTree } from './components/FileTree';
import { Wordmark } from './components/Logo';
import { SessionsView, folderName as sessionFolder, timeAgo } from './components/SessionsView';
import { SettingsView } from './components/SettingsView';
import { useApp } from './store';

function GatewayPill() {
  const fcc = useApp((s) => s.fcc);
  const label = { stopped: 'Models offline', starting: 'Models starting…', running: 'Models ready', error: 'Models unavailable' }[fcc.state];
  return (
    <span className={`pill ${fcc.state}`} title={fcc.message ?? `The model gateway connects ${AGENT_NAME} to your model providers.`}>
      <span className="dot" />
      {label}
    </span>
  );
}

/** The welcome screen's shortcut back into recent work, in any project. */
function RecentChats() {
  const [recent, setRecent] = useState<SessionSummary[]>([]);
  const { resumeSession, setSessionsOpen } = useApp.getState();
  useEffect(() => {
    void api.sessions.list().then((list) => setRecent(list.slice(0, 5)));
  }, []);
  if (!recent.length) return null;
  return (
    <div className="recent-chats">
      <div className="recent-head">
        <span>Recent chats</span>
        <button className="link" onClick={() => setSessionsOpen(true)}>
          All past chats
        </button>
      </div>
      {recent.map((session) => (
        <button key={session.id} className="session-row" onClick={() => void resumeSession(session.id)} title={session.cwd}>
          <span className="session-title">{session.title}</span>
          <span className="session-meta">
            {sessionFolder(session.cwd)} · {timeAgo(session.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function compactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** How full the chat's context is, against the auto-compaction limit. Click to compact now. */
function ContextMeter() {
  const usage = useApp((s) => s.transcript.tokenUsage);
  const limit = useApp((s) => s.settings?.autoCompactTokens) || usage?.modelContextWindow || 0;
  const running = useApp((s) => s.transcript.running);
  if (!usage || !limit) return null;
  const used = usage.last.inputTokens;
  const share = Math.min(1, used / limit);
  return (
    <button
      className={`context-meter${share > 0.8 ? ' high' : ''}`}
      onClick={() => void useApp.getState().runCommand('/compact')}
      disabled={running}
      title={`Context: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens before the chat compacts itself. Click to compact now.`}
    >
      <span className="meter-bar">
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="mono">
        {compactNumber(used)} / {compactNumber(limit)}
      </span>
    </button>
  );
}

/** Bottom bar: which provider and model the chat uses, how much of the context it has used, and the brand's one running joke. */
function StatusBar() {
  const fcc = useApp((s) => s.fcc);
  const model = useApp((s) => s.transcript.model ?? s.model);
  const usage = useApp((s) => s.transcript.tokenUsage);
  return (
    <footer className="statusbar">
      <span className={`pill ${fcc.state}`}>
        <span className="dot" />
      </span>
      {model ? (
        <span title={model}>
          {providerName(model)} · <span className="mono">{shortModelName(model)}</span>
        </span>
      ) : (
        <span>No model yet</span>
      )}
      {usage && (
        <span className="mono with-icon" title="Tokens used in this chat">
          <Coins size={13} />
          {usage.total.totalTokens.toLocaleString()} tokens
        </span>
      )}
      <ContextMeter />
      <span className="spacer" />
      <span className="mono spent" title={`${APP_NAME} costs nothing and adds nothing to your bills. Providers may charge only if you use paid models on your own account.`}>
        <span className="accent">$0</span>.00 spent
      </span>
    </footer>
  );
}

export function App() {
  const workspace = useApp((s) => s.workspace);
  const fcc = useApp((s) => s.fcc);
  const models = useApp((s) => s.models);
  const setSettingsPage = useApp((s) => s.setSettingsPage);

  useEffect(() => {
    const { onAgentEvent, onFilesChanged, loadModels } = useApp.getState();
    const onStatus = (status: typeof fcc) => {
      useApp.setState({ fcc: status });
      if (status.state === 'running') void loadModels();
    };
    void api.fcc.status().then(onStatus);
    void api.workspace.current().then((root) => root && useApp.setState({ workspace: root }));
    const offs = [api.fcc.onStatus(onStatus), api.workspace.onChanged((paths) => void onFilesChanged(paths))];
    // After a reload (or crash recovery) the chat is still alive in the main process: rebuild it, then
    // subscribe. Events sent after the history reply arrive after it, so nothing is doubled or lost.
    let cancelled = false;
    void api.agent.history().then((events) => {
      if (cancelled) return;
      useApp.getState().replayAgentEvents(events);
      offs.push(api.agent.onEvent(onAgentEvent));
    });
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, []);

  const needsKey = fcc.state === 'running' && models.length === 0;
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Wordmark height={15} title={APP_NAME} />
        </span>
        {workspace && (
          <span className="project" title={workspace}>
            {folderName(workspace)}
          </span>
        )}
        <button className="btn" onClick={() => void useApp.getState().openFolder()}>
          <FolderOpen />
          {workspace ? 'Open another folder' : 'Open folder'}
        </button>
        <span className="spacer" />
        <GatewayPill />
        {fcc.state === 'error' && (
          <button className="btn" onClick={() => void api.fcc.restart()}>
            <ArrowClockwise />
            Restart models
          </button>
        )}
        <button className="btn" onClick={() => setSettingsPage('providers')}>
          <GearSix />
          Settings
        </button>
      </header>
      {workspace ? (
        <main className="workbench">
          <FileTree />
          <EditorArea />
          <AgentPanel />
        </main>
      ) : (
        <main className="welcome">
          <Wordmark height={44} title={APP_NAME} />
          <p className="tagline">{TAGLINE}</p>
          <p className="muted">Open a folder and tell {AGENT_NAME} what to change.</p>
          <button className="btn primary large" onClick={() => void useApp.getState().openFolder()}>
            <FolderOpen size={18} />
            Open a folder
          </button>
          {needsKey ? (
            <p>
              First, <button className="link" onClick={() => setSettingsPage('providers')}>add a free model key</button>.
            </p>
          ) : (
            <p className="muted">{fcc.state === 'running' ? 'Models ready.' : (fcc.message ?? 'Starting the model gateway…')}</p>
          )}
          {fcc.state === 'running' && !needsKey && <RecentChats />}
        </main>
      )}
      <StatusBar />
      <SettingsView />
      <SessionsView />
    </div>
  );
}
