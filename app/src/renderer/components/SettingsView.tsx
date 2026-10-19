// Settings: model providers (keys), appearance, about, and acknowledgements of the software the app is built on.
import { BookOpen, Cpu, ChatText, Check, Heart, Info, Palette, PlugsConnected, X, type Icon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { BACKUP_DELAY_CHOICES, type AboutInfo, type ProviderInfo } from '../../shared/ipc';
import { AGENT_NAME } from '../../shared/brand';
import { THEMES, type ThemeInfo, type ThemeSetting } from '../../shared/themes';
import { ACKNOWLEDGEMENTS } from '../acknowledgements';
import { api, errorMessage } from '../api';
import { useApp, type SettingsPage } from '../store';
import { Collapsible } from './Collapsible';
import { IntegrationsPage } from './IntegrationsPage';
import { SkillsPage } from './SkillsPage';

const PAGES: { id: SettingsPage; label: string; icon: Icon }[] = [
  { id: 'providers', label: 'Models & providers', icon: Cpu },
  { id: 'chat', label: 'Chat', icon: ChatText },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'integrations', label: 'Integrations', icon: PlugsConnected },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
  { id: 'acknowledgements', label: 'Acknowledgements', icon: Heart },
];

/** How many providers to show before "Show all". */
const SHORT_LIST = 8;

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button type="button" className="link" title={href} onClick={() => void api.app.openExternal(href)}>
      {children}
    </button>
  );
}

function ProviderRow({ provider, onSaved }: { provider: ProviderInfo; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const save = async (value: string) => {
    setBusy(true);
    setResult(undefined);
    try {
      const outcome = await api.fcc.saveKey(provider.id, value);
      setResult(outcome);
      if (outcome.ok) {
        setKey('');
        onSaved();
      }
    } catch (error) {
      setResult({ ok: false, message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="provider">
      <div className="provider-head">
        <strong>{provider.name}</strong>
        <span className={`badge ${provider.configured ? 'ok' : ''}`}>{provider.configured ? 'Key set' : provider.status}</span>
        <span className="spacer" />
        {provider.website && <ExternalLink href={provider.website}>Get a key</ExternalLink>}
      </div>
      <form
        className="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim()) void save(key);
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.configured ? 'Paste a new key to replace it' : 'Paste an API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={`${provider.name} API key`}
          disabled={busy}
        />
        <button className="btn primary small" type="submit" disabled={busy || !key.trim()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
        {provider.configured && (
          <button className="btn small" type="button" disabled={busy} onClick={() => void save('')}>
            Remove
          </button>
        )}
      </form>
      {result && <p className={result.ok ? 'muted' : 'error-text'}>{result.message}</p>}
    </div>
  );
}

function ProvidersPage() {
  const fcc = useApp((s) => s.fcc);
  const [providers, setProviders] = useState<ProviderInfo[]>();
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const load = () =>
    api.fcc
      .providers()
      .then((list) => {
        setProviders(list);
        setError(undefined);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    if (fcc.state === 'running') void load();
  }, [fcc.state]);

  if (fcc.state !== 'running') return <p className="muted">{fcc.message ?? 'The model gateway is starting…'}</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!providers) return <p className="muted">Loading providers…</p>;
  const configured = providers.filter((p) => p.configured).length;
  const visible = showAll ? providers : providers.slice(0, Math.max(SHORT_LIST, configured));
  return (
    <>
      <p className="muted">
        Add a key for at least one provider. Most offer a free tier: open <em>Get a key</em>, create a key there, and paste it here. Each key is checked with the provider
        before it's saved, and stays on this computer.
      </p>
      {visible.map((provider) => (
        <ProviderRow key={provider.id} provider={provider} onSaved={() => void load()} />
      ))}
      {providers.length > visible.length && (
        <button className="btn small" onClick={() => setShowAll(true)}>
          Show all {providers.length} providers
        </button>
      )}
      <h3>Advanced</h3>
      <p className="muted">Fallback chains, rate limits, custom endpoints and other options of the bundled model gateway.</p>
      <button className="btn small" onClick={() => void api.fcc.openAdmin()}>
        Advanced gateway settings…
      </button>
    </>
  );
}

function useAbout(): AboutInfo | undefined {
  const [about, setAbout] = useState<AboutInfo>();
  useEffect(() => {
    void api.app.about().then(setAbout);
  }, []);
  return about;
}

/** A tiny drawing of the app in a theme's colors: top bar, file tree, editor lines, Penny's panel. */
function ThemePreview({ theme }: { theme: ThemeInfo }) {
  const c = theme.colors;
  return (
    <div className="theme-preview" style={{ background: c.bg, borderColor: c.border }} aria-hidden="true">
      <div className="tp-top" style={{ background: c.chrome, borderColor: c.border }}>
        <span style={{ background: c.text }} />
      </div>
      <div className="tp-body">
        <div className="tp-tree" style={{ borderColor: c.border }}>
          <span style={{ background: c.muted }} />
          <span className="tp-selected" style={{ background: c.tint }} />
          <span style={{ background: c.muted }} />
        </div>
        <div className="tp-code">
          <span style={{ background: c.accent, width: '40%' }} />
          <span style={{ background: c.muted, width: '70%' }} />
          <span style={{ background: c.muted, width: '55%' }} />
        </div>
        <div className="tp-panel" style={{ background: c.panel, borderColor: c.border }}>
          <span className="tp-bubble" style={{ background: c.surface }} />
          <span style={{ background: c.text, width: '80%' }} />
          <span className="tp-send" style={{ borderColor: c.accent }} />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ value, label, description, preview, selected, onPick }: { value: ThemeSetting; label: string; description: string; preview: React.ReactNode; selected: boolean; onPick: (v: ThemeSetting) => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`theme-card${selected ? ' selected' : ''}`} onClick={() => onPick(value)}>
      {preview}
      <span className="theme-name">
        {label}
        {selected && <Check size={14} weight="bold" />}
      </span>
      <span className="muted">{description}</span>
    </button>
  );
}

function AppearancePage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const current = settings?.theme ?? 'system';
  const pick = (theme: ThemeSetting) => void updateSettings({ theme });
  const [night, day] = [THEMES.find((t) => t.id === 'night')!, THEMES.find((t) => t.id === 'day')!];
  return (
    <>
      <h3>Theme</h3>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        <ThemeCard
          value="system"
          label="Match Windows"
          description="Night when Windows is dark, Day when it’s light."
          selected={current === 'system'}
          onPick={pick}
          preview={
            <div className="theme-split">
              <ThemePreview theme={night} />
              <ThemePreview theme={day} />
            </div>
          }
        />
        {THEMES.map((theme) => (
          <ThemeCard key={theme.id} value={theme.id} label={theme.name} description={theme.description} selected={current === theme.id} onPick={pick} preview={<ThemePreview theme={theme} />} />
        ))}
      </div>
    </>
  );
}

const COMPACT_CHOICES: { value: number; label: string }[] = [
  { value: 32_000, label: '32k tokens: saves the most, best for free tiers with low limits' },
  { value: 64_000, label: '64k tokens (recommended)' },
  { value: 128_000, label: '128k tokens: keeps more detail, needs a model with a big context' },
  { value: 0, label: 'Never: only when I type /compact' },
];

function ChatPage() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  if (!settings) return null;
  return (
    <>
      <h3>Backup model</h3>
      <p className="muted">
        Free models are sometimes slow or full. With Backup on, a second model is asked too when the first is slow, and whichever answers first is used. If your
        model hits its limit, the chat switches to the backup and tells you, with a way back.
      </p>
      <div className="field">
        <span id="backup-delay">When the model is slow, also ask a backup after</span>
        <div className="segmented" role="radiogroup" aria-labelledby="backup-delay">
          {BACKUP_DELAY_CHOICES.map((ms) => (
            <button
              key={ms}
              type="button"
              role="radio"
              aria-checked={settings.hedgeDelayMs === ms}
              className={settings.hedgeDelayMs === ms ? 'on' : ''}
              disabled={!settings.hedge}
              onClick={() => void updateSettings({ hedgeDelayMs: ms })}
            >
              {ms / 1000}s
            </button>
          ))}
        </div>
      </div>
      {!settings.hedge && <p className="muted small">Turn on Backup (under the model picker) to use this. While it's off, only the model you picked answers.</p>}
      <h3>Compaction</h3>
      <p className="muted">
        Long chats resend everything to the model on every step, which uses up free-tier limits and slows models down. Compaction replaces the chat so far with a summary
        ({AGENT_NAME} keeps the task, the changes, the decisions and what's next) and carries on from there.
      </p>
      <label className="field">
        <span>Compact automatically at</span>
        <select value={settings.autoCompactTokens} onChange={(e) => void updateSettings({ autoCompactTokens: Number(e.target.value) })}>
          {COMPACT_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Applies from the next chat. Type /compact to compact any time, or click the context meter in the status bar.</p>
      <h3>Commands</h3>
      <p className="muted">
        Type / in the message box for the list. Your own commands are Markdown files in <code>~/.mooch/commands</code> (and a project's in <code>.mooch/commands</code>): each <code>name.md</code> becomes /name.
      </p>
      <button className="btn small" onClick={() => void api.commands.openFolder()}>
        Open my commands folder
      </button>
    </>
  );
}

function AboutPage() {
  const about = useAbout();
  if (!about) return null;
  return (
    <>
      <dl className="facts">
        <dt>Version</dt>
        <dd>{about.version}</dd>
        <dt>Agent engine</dt>
        <dd>{about.codexVersion}</dd>
        <dt>Model gateway</dt>
        <dd>{about.gatewayVersion}</dd>
        <dt>Electron</dt>
        <dd>
          {about.electron} (Chromium {about.chromium}, Node.js {about.node})
        </dd>
        <dt>Data folder</dt>
        <dd>
          <code>{about.dataFolder}</code>
        </dd>
        {about.runtimeFolder && (
          <>
            <dt>Gateway runtime</dt>
            <dd>
              <code>{about.runtimeFolder}</code>
            </dd>
          </>
        )}
      </dl>
      <p className="muted">
        Settings, restore points, provider keys and logs stay in the data folder on this computer. Your code and chats go only to the model providers you add keys
        for. The first start also downloads the model gateway's Python runtime and packages. There is no telemetry.
      </p>
      <div className="actions wrap">
        <button className="btn small" onClick={() => void api.app.openDataFolder()}>
          Open data folder
        </button>
        {about.runtimeFolder && <RemoveRuntime />}
      </div>
    </>
  );
}

/** Before deleting the app (macOS has no uninstaller): frees the ~300 MB the gateway's Python runtime takes. */
function RemoveRuntime() {
  const [state, setState] = useState<'idle' | 'confirm' | 'done' | string>('idle');
  if (state === 'done') return <span className="muted small">Removed. It is set up again the next time mooch starts.</span>;
  if (state === 'confirm') {
    return (
      <>
        <span className="small">Stop the model gateway and delete its runtime (about 300 MB)?</span>
        <button className="btn small danger" onClick={() => void api.app.removeRuntime().then(() => setState('done'), (e) => setState(errorMessage(e)))}>
          Remove
        </button>
        <button className="btn small" onClick={() => setState('idle')}>
          Keep
        </button>
      </>
    );
  }
  return (
    <>
      <button className="btn small" onClick={() => setState('confirm')} title="Frees disk space; useful before deleting the app">
        Remove gateway runtime
      </button>
      {state !== 'idle' && <span className="small bad-text">{state}</span>}
    </>
  );
}

function AcknowledgementsPage() {
  const about = useAbout();
  return (
    <>
      <p className="muted">
        {about?.name ?? 'This app'} is built on the open-source software below. Thank you to everyone who works on it.
      </p>
      <ul className="acks">
        {ACKNOWLEDGEMENTS.map((ack) => (
          <li key={ack.name}>
            <div className="ack-head">
              <strong>{ack.name}</strong>
              <span className="badge">{ack.license}</span>
              <span className="spacer" />
              <ExternalLink href={ack.url}>Source</ExternalLink>
            </div>
            <div className="muted">{ack.role}</div>
            {ack.note && <div className="ack-note">{ack.note}</div>}
          </li>
        ))}
      </ul>
      <p className="muted">The AI models themselves are provided by the services you add keys for, under their own terms.</p>
      {about?.notices ? (
        <Collapsible title={<span>Full license texts</span>}>
          <pre className="notices">{about.notices}</pre>
        </Collapsible>
      ) : (
        <p className="muted">Full license texts are included in installed builds.</p>
      )}
    </>
  );
}

export function SettingsView() {
  const page = useApp((s) => s.settingsPage);
  const setSettingsPage = useApp((s) => s.setSettingsPage);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsPage(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSettingsPage]);
  if (!page) return null;
  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsPage(undefined)}>
      <section className="settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav">
          <h2>Settings</h2>
          {PAGES.map((p) => (
            <button key={p.id} className={`settings-tab${p.id === page ? ' active' : ''}`} onClick={() => setSettingsPage(p.id)}>
              <p.icon weight={p.id === page ? 'fill' : 'regular'} />
              {p.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-title">
            <h2>{PAGES.find((p) => p.id === page)?.label}</h2>
            <span className="spacer" />
            <button className="tab-close" onClick={() => setSettingsPage(undefined)} aria-label="Close settings">
              <X />
            </button>
          </div>
          {page === 'providers' && <ProvidersPage />}
          {page === 'chat' && <ChatPage />}
          {page === 'skills' && <SkillsPage />}
          {page === 'integrations' && <IntegrationsPage />}
          {page === 'appearance' && <AppearancePage />}
          {page === 'about' && <AboutPage />}
          {page === 'acknowledgements' && <AcknowledgementsPage />}
        </div>
      </section>
    </div>
  );
}
