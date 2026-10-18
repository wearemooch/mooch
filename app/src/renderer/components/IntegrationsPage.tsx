// Settings > Integrations: MCP servers that let Penny use other apps and services as tools.
import { ArrowsClockwise, CaretRight, ClipboardText, DownloadSimple, FileText, PencilSimple, Plus, SignIn, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { AGENT_NAME } from '../../shared/brand';
import type { McpServerEntry, McpServerView } from '../../shared/ipc';
import { api, errorMessage } from '../api';

const STATE_LABEL: Record<McpServerView['state'], string> = {
  ready: 'Connected',
  starting: 'Starting…',
  failed: 'Failed',
  needsLogin: 'Needs sign-in',
  off: 'Off',
  unknown: 'Connects when a chat starts',
};

/** A server as the edit form holds it: lists and maps as editable text. */
interface Draft {
  original?: string;
  name: string;
  kind: 'command' | 'url';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

const toDraft = (s?: McpServerEntry): Draft => ({
  original: s?.name,
  name: s?.name ?? '',
  kind: s?.url ? 'url' : 'command',
  command: s?.command ?? '',
  args: (s?.args ?? []).join('\n'),
  env: Object.entries(s?.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
  url: s?.url ?? '',
  headers: Object.entries(s?.headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
});

function pairs(text: string, separator: RegExp): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = separator.exec(line);
      return match ? ([line.slice(0, match.index).trim(), line.slice(match.index + match[0].length).trim()] as [string, string]) : undefined;
    })
    .filter((e): e is [string, string] => !!e && !!e[0]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function fromDraft(d: Draft, previous?: McpServerEntry): McpServerEntry {
  const base = { name: d.name.trim(), disabled: previous?.disabled, alwaysAllow: previous?.alwaysAllow };
  if (d.kind === 'url') return { ...base, url: d.url.trim(), headers: pairs(d.headers, /:/) };
  return {
    ...base,
    command: d.command.trim(),
    args: d.args
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean),
    env: pairs(d.env, /=/),
    cwd: previous?.cwd,
  };
}

function ServerForm({ draft, onSave, onCancel }: { draft: Draft; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  return (
    <form
      className="card mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="github" autoFocus />
      </label>
      <div className="segmented" role="radiogroup" aria-label="Kind">
        <button type="button" role="radio" aria-checked={d.kind === 'command'} className={d.kind === 'command' ? 'on' : ''} onClick={() => set({ kind: 'command' })}>
          Program on this computer
        </button>
        <button type="button" role="radio" aria-checked={d.kind === 'url'} className={d.kind === 'url' ? 'on' : ''} onClick={() => set({ kind: 'url' })}>
          Remote server (URL)
        </button>
      </div>
      {d.kind === 'command' ? (
        <>
          <label className="field">
            <span>Command</span>
            <input className="mono" value={d.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
          </label>
          <label className="field">
            <span>Arguments, one per line</span>
            <textarea className="mono" rows={3} value={d.args} onChange={(e) => set({ args: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Documents'} />
          </label>
          <label className="field">
            <span>Environment variables, KEY=value per line</span>
            <textarea className="mono" rows={2} value={d.env} onChange={(e) => set({ env: e.target.value })} placeholder="GITHUB_TOKEN=…" />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>URL</span>
            <input className="mono" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/mcp" />
          </label>
          <label className="field">
            <span>Headers, Name: value per line (optional; servers with sign-in don't need any)</span>
            <textarea className="mono" rows={2} value={d.headers} onChange={(e) => set({ headers: e.target.value })} placeholder="Authorization: Bearer …" />
          </label>
        </>
      )}
      <p className="muted small">Saved in plain text in ~/.mooch/mcp.json, like other apps' MCP files.</p>
      <div className="actions">
        <button className="btn primary small" type="submit">
          Save
        </button>
        <button className="btn small" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ServerRow({ server, onEdit, onToggle, onRemove, onLogin }: { server: McpServerView; onEdit: () => void; onToggle: () => void; onRemove: () => void; onLogin: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mcp-row">
      <div className="mcp-head">
        <span className={`status-dot ${server.state}`} title={STATE_LABEL[server.state]} />
        <div className="mcp-text">
          <div>
            <strong>{server.name}</strong> <span className="muted small">{STATE_LABEL[server.state]}</span>
          </div>
          <div className="mono muted small ellipsis">{server.url ?? [server.command, ...(server.args ?? [])].join(' ')}</div>
          {server.error && <div className="small bad-text">{server.error}</div>}
        </div>
        {server.state === 'needsLogin' && (
          <button className="btn small" onClick={onLogin}>
            <SignIn size={14} />
            Sign in
          </button>
        )}
        <button className="btn small" onClick={onToggle}>
          {server.disabled ? 'Turn on' : 'Turn off'}
        </button>
        <button className="icon-btn" onClick={onEdit} title="Edit" aria-label={`Edit ${server.name}`}>
          <PencilSimple size={14} />
        </button>
        <button className="icon-btn" onClick={onRemove} title="Remove" aria-label={`Remove ${server.name}`}>
          <Trash size={14} />
        </button>
      </div>
      {server.tools.length > 0 && (
        <button className="link mcp-tools-toggle" onClick={() => setOpen(!open)}>
          <CaretRight size={10} className={`tree-caret${open ? ' open' : ''}`} />
          {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
        </button>
      )}
      {open && (
        <ul className="mcp-tools">
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <span className="mono">{tool.name}</span>
              {tool.readOnly && <span className="tag">read-only</span>}
              {server.alwaysAllow?.includes(tool.name) && <span className="tag">always allowed</span>}
              {tool.description && <span className="muted small block">{tool.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IntegrationsPage() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [fileError, setFileError] = useState<string>();
  const [editing, setEditing] = useState<Draft>();
  const [pasting, setPasting] = useState<string>();
  const [importable, setImportable] = useState<(McpServerEntry & { app: string })[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string>();

  const reload = () =>
    void api.mcp.list().then((result) => {
      setServers(result.servers);
      setFileError(result.error);
    });
  useEffect(() => {
    reload();
    // Servers connect in the background; keep their state current while the page is open.
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, []);

  const entries = (): McpServerEntry[] => servers.map(({ state: _s, error: _e, tools: _t, ...entry }) => entry);
  const save = async (list: McpServerEntry[], done?: string) => {
    setMessage(undefined);
    try {
      await api.mcp.save(list);
      setMessage(done);
      reload();
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    }
  };
  const addMany = async (added: McpServerEntry[]) => {
    const names = new Set(added.map((s) => s.name));
    if (await save([...entries().filter((s) => !names.has(s.name)), ...added], `Added ${added.map((s) => s.name).join(', ')}.`)) {
      setPasting(undefined);
      setImportable(undefined);
    }
  };

  return (
    <>
      <p className="muted">
        Integrations (MCP servers) let {AGENT_NAME} use other apps and services as tools: files, browsers, GitHub, databases, design tools and more. Tools that only read run on their
        own; tools that change something ask first, unless the chat is in Full auto or you chose "Always" for that tool.
      </p>
      <p className="muted small">Servers run on this computer with your permissions, so add only ones you trust.</p>
      <div className="actions wrap">
        <button className="btn small" onClick={() => setEditing(toDraft())}>
          <Plus size={14} />
          Add server
        </button>
        <button className="btn small" onClick={() => setPasting(pasting === undefined ? '' : undefined)}>
          <ClipboardText size={14} />
          Paste JSON
        </button>
        <button
          className="btn small"
          onClick={() =>
            void api.mcp.importable().then((list) => {
              setImportable(list);
              setPicked(new Set(list.map((s) => `${s.app}:${s.name}`)));
            })
          }
        >
          <DownloadSimple size={14} />
          Import from other apps
        </button>
        <button className="btn small" onClick={() => void api.mcp.openFile()}>
          <FileText size={14} />
          Open mcp.json
        </button>
        <button className="icon-btn" onClick={reload} title="Refresh" aria-label="Refresh">
          <ArrowsClockwise size={14} />
        </button>
      </div>
      {message && <p className="notice-inline">{message}</p>}
      {fileError && <p className="notice-inline">{fileError}</p>}

      {editing && (
        <ServerForm
          draft={editing}
          onCancel={() => setEditing(undefined)}
          onSave={(d) => {
            const previous = entries().find((s) => s.name === d.original);
            const updated = fromDraft(d, previous);
            const rest = entries().filter((s) => s.name !== d.original);
            void save(d.original ? entries().map((s) => (s.name === d.original ? updated : s)) : [...rest, updated], `Saved ${updated.name}.`).then((ok) => ok && setEditing(undefined));
          }}
        />
      )}

      {pasting !== undefined && (
        <div className="card mcp-form">
          <label className="field">
            <span>Paste a server config from a README (the {'{ "mcpServers": … }'} block)</span>
            <textarea className="mono" rows={7} value={pasting} onChange={(e) => setPasting(e.target.value)} autoFocus placeholder={'{\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  }\n}'} />
          </label>
          <div className="actions">
            <button
              className="btn primary small"
              disabled={!pasting.trim()}
              onClick={() =>
                void api.mcp
                  .parse(pasting)
                  .then((found) => (found.length ? addMany(found) : setMessage('No server found in that JSON.')))
                  .catch((error) => setMessage(errorMessage(error)))
              }
            >
              Add
            </button>
            <button className="btn small" onClick={() => setPasting(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {importable && (
        <div className="card mcp-form">
          {importable.length === 0 ? (
            <p className="muted">No servers found in Claude Desktop, Claude Code, Cursor or Windsurf.</p>
          ) : (
            <>
              <div className="card-title">Servers from your other apps</div>
              {importable.map((s) => {
                const key = `${s.app}:${s.name}`;
                return (
                  <label key={key} className="skill-candidate">
                    <input type="checkbox" checked={picked.has(key)} onChange={() => setPicked((p) => (p.has(key) ? new Set([...p].filter((k) => k !== key)) : new Set([...p, key])))} />
                    <span>
                      <strong>{s.name}</strong> <span className="tag">{s.app}</span>
                      <span className="mono muted small block">{s.url ?? [s.command, ...(s.args ?? [])].join(' ')}</span>
                    </span>
                  </label>
                );
              })}
            </>
          )}
          <div className="actions">
            {importable.length > 0 && (
              <button className="btn primary small" disabled={!picked.size} onClick={() => void addMany(importable.filter((s) => picked.has(`${s.app}:${s.name}`)).map(({ app: _a, ...s }) => s))}>
                Add selected
              </button>
            )}
            <button className="btn small" onClick={() => setImportable(undefined)}>
              Close
            </button>
          </div>
        </div>
      )}

      <h3>Servers</h3>
      {servers.length === 0 && <p className="muted">None yet. Add one, paste one from a README, or import the ones you use in other apps.</p>}
      <div className="skill-list">
        {servers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            onEdit={() => setEditing(toDraft(server))}
            onToggle={() => void save(entries().map((s) => (s.name === server.name ? { ...s, disabled: !s.disabled || undefined } : s)))}
            onRemove={() => void save(entries().filter((s) => s.name !== server.name), `Removed ${server.name}.`)}
            onLogin={() => void api.mcp.login(server.name).catch((error) => setMessage(errorMessage(error)))}
          />
        ))}
      </div>
    </>
  );
}
