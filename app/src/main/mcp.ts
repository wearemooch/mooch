// MCP integrations: servers Penny can use as tools. The user's list lives in ~/.mooch/mcp.json in the
// common { "mcpServers": { name: {...} } } format (Claude Desktop, Cursor and most docs use it), so
// snippets paste straight in. mooch turns it into the engine's [mcp_servers] config.
// Only the user's own file is read: a project cannot add servers (they would run programs on open).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { McpServerEntry } from '../shared/ipc';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(([k, v]) => k && typeof v === 'string') as [string, string][];
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** One server from any of the common formats; undefined when it isn't usable. */
export function normalizeServer(name: string, raw: unknown): McpServerEntry | undefined {
  if (!NAME.test(name) || !raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url : typeof r.serverUrl === 'string' ? r.serverUrl : undefined;
  const command = typeof r.command === 'string' ? r.command : undefined;
  if (!url && !command) return undefined;
  const entry: McpServerEntry = { name };
  if (command) {
    entry.command = command;
    if (Array.isArray(r.args)) entry.args = r.args.filter((a): a is string => typeof a === 'string');
    entry.env = stringMap(r.env);
    if (typeof r.cwd === 'string') entry.cwd = r.cwd;
  } else if (url) {
    entry.url = url;
    entry.headers = stringMap(r.headers);
  }
  if (r.disabled === true || r.enabled === false) entry.disabled = true;
  if (Array.isArray(r.alwaysAllow)) entry.alwaysAllow = r.alwaysAllow.filter((t): t is string => typeof t === 'string');
  return entry;
}

/** Servers from pasted or imported JSON: { mcpServers: {...} }, VS Code's { servers: {...} }, or a bare map. */
export function parseMcpJson(text: string): McpServerEntry[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const map = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map).flatMap(([name, raw]) => normalizeServer(name, raw) ?? []);
}

/** Why a server can't be saved, or undefined. */
export function validateServer(entry: McpServerEntry): string | undefined {
  if (!NAME.test(entry.name)) return 'Use letters, digits, - and _ for the name (up to 64).';
  if (entry.url) {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      return 'That URL is not valid.';
    }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'Use an https:// URL (http:// only for servers on this computer).';
    return undefined;
  }
  if (!entry.command?.trim()) return 'Give a command (like npx) or a URL.';
  return undefined;
}

export function readMcpConfig(file: string): { servers: McpServerEntry[]; error?: string } {
  if (!existsSync(file)) return { servers: [] };
  try {
    return { servers: parseMcpJson(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { servers: [], error: `mcp.json could not be read: ${(error as Error).message}` };
  }
}

export function writeMcpConfig(file: string, servers: McpServerEntry[]): void {
  const mcpServers: Record<string, Json> = {};
  for (const { name, ...rest } of servers) {
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
    mcpServers[name] = clean as Json;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * The engine's [mcp_servers] table. The engine asks before tools that aren't marked read-only
 * ("writes"); mooch answers those prompts by the chat's permission mode. "Always allow" tools never ask.
 */
export function toEngineServers(servers: McpServerEntry[], resolveCommand: (command: string) => string = (c) => c): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const s of servers) {
    if (s.disabled || validateServer(s)) continue;
    const common: Record<string, Json> = {
      default_tools_approval_mode: 'writes',
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
      ...(s.alwaysAllow?.length ? { tools: Object.fromEntries(s.alwaysAllow.map((t) => [t, { approval_mode: 'approve' }])) } : {}),
    };
    out[s.name] = s.url
      ? { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}), ...common }
      : { command: resolveCommand(s.command!), ...(s.args?.length ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), ...common };
  }
  return out;
}

/** MCP config files of other apps, for "Import". */
export function otherAppMcpConfigs(home = homedir(), appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')): { app: string; file: string }[] {
  const claudeDesktop =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32'
        ? path.join(appData, 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  return [
    { app: 'Claude Desktop', file: claudeDesktop },
    { app: 'Claude Code', file: path.join(home, '.claude.json') },
    { app: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { app: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
}

/** Servers found in other apps' config files, tagged with the app. */
export function findImportableServers(configs = otherAppMcpConfigs()): (McpServerEntry & { app: string })[] {
  const found: (McpServerEntry & { app: string })[] = [];
  for (const { app, file } of configs) {
    try {
      if (!existsSync(file)) continue;
      for (const server of parseMcpJson(readFileSync(file, 'utf8'))) found.push({ ...server, app });
    } catch {
      // unreadable or not JSON: skip
    }
  }
  return found;
}
