import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_ID, APP_NAME, DATA_FOLDER, PREVIOUS_DATA_FOLDER } from '../shared/brand';
import { resolveTheme } from '../shared/themes';
import type { McpServerView } from '../shared/ipc';
import type { AboutInfo, AgentEvent, ApprovalDecision, FccStatus, NewThreadOptions, SendOptions } from '../shared/ipc';
import { AgentController } from './agent';
import { AgentEventStream } from './eventStream';
import { listProviders, saveProviderKey } from './fcc/providers';
import { carryOverData } from './migrate';
import { moochPaths } from './paths';
import { engineTarget, exe, runtimeFolder as platformRuntimeFolder } from './platform';
import { isSessionId, SessionRecorder, SessionStore } from './sessions';
import { loadCustomCommands } from './slashCommands';
import { SkillManager } from './skills';
import { findImportableServers, normalizeServer, parseMcpJson, readMcpConfig, toEngineServers, validateServer, writeMcpConfig } from './mcp';
import { findExecutable } from './exec';
import { FccSidecar } from './fcc/sidecar';
import { removeTreeNoFollow } from './race/workspaceCopy';
import { SettingsStore } from './settings';
import { PromptLibrary } from './team/prompts';
import { Workspace } from './workspace';

// Electron's own data (Chromium caches, the instance lock) stays in the OS app-data folder.
app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));
// The user's things live in ~/.mooch. On first start, keep the keys and settings earlier versions kept
// in the app-data folder ("mooch", or "free-code" before the rename).
const paths = moochPaths();
const carriedOver = carryOverData([app.getPath('userData'), path.join(app.getPath('appData'), PREVIOUS_DATA_FOLDER)], paths.home);
mkdirSync(paths.home, { recursive: true });
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Developer overrides only work in unpacked development builds; an installed app ignores them, so an
// environment variable can never point the window (and its privileged API) at another page.
const dev = !app.isPackaged;
const DEV_URL = dev ? process.env.FREE_CODE_DEV_URL : undefined;
// Development: out/main -> the app folder. Installed: the resources folder next to app.asar.
const appRoot = path.resolve(__dirname, '..', '..');
const resources = dev ? path.resolve(appRoot, 'build', 'stage') : process.resourcesPath;

const engine = engineTarget();
const codexVendor = dev ? path.join(appRoot, 'node_modules', ...engine.pkg.split('/'), 'vendor', engine.triple) : path.join(resources, 'codex');
const codexBinary = (dev && process.env.FREE_CODE_CODEX_BIN) || path.join(codexVendor, 'bin', exe('codex'));
const gatewayProject = dev ? process.env.FREE_CODE_FCC_PROJECT ?? path.resolve(appRoot, '..', '_reference', 'free-claude-code') : path.join(resources, 'gateway');

/** Versions of the bundled components, written by scripts/stage.mjs; read from the dev checkout otherwise. */
function bundledVersions(): { codex: string; gateway: string } {
  try {
    return JSON.parse(readFileSync(path.join(resources, 'versions.json'), 'utf8'));
  } catch {
    const codex = (() => {
      try {
        return JSON.parse(readFileSync(path.join(appRoot, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')).version as string;
      } catch {
        return 'unknown';
      }
    })();
    return { codex, gateway: 'development checkout' };
  }
}
const versions = bundledVersions();

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  // A second copy would fight the first over the gateway's config and ports. app.quit() would still run
  // the startup below (and start a second gateway); exit right away instead. The first copy gets our
  // command line through 'second-instance'.
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let workspace: Workspace | null = null;

const logDir = paths.logs;
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'main.log');
/** Appends to logs/main.log, keeping one previous file once it passes 5 MB. */
function log(line: string): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // logging must never take the app down
  }
}
process.on('uncaughtException', (error) => log(`[uncaught] ${error.stack ?? error.message}`));
process.on('unhandledRejection', (reason) => log(`[unhandled] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));

const runtimeFolder = dev ? undefined : platformRuntimeFolder(paths.home, process.platform, process.env, DATA_FOLDER);
const fcc = new FccSidecar({
  projectDir: gatewayProject,
  homeDir: paths.gateway,
  uvCommand: dev ? undefined : path.join(resources, 'bin', exe('uv')),
  // Python and the gateway's packages, outside the app's install folder so updates keep them (see platform.ts).
  runtimeDir: runtimeFolder,
  version: dev ? undefined : versions.gateway,
});
const codexHome = paths.engine;
mkdirSync(codexHome, { recursive: true });

/** False while the window's page is loading, reloading or crashed: sends then go nowhere. */
let rendererReady = false;

function send(channel: string, payload: unknown): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed()) return;
  mainWindow.webContents.send(channel, payload);
}

const agentEvents = new AgentEventStream((event) => send('agent:event', event));

const raceRoot = paths.races;
const settings = new SettingsStore(paths.settings);
const agent = new AgentController({
  fcc,
  codexBinary,
  codexHome,
  raceRoot,
  checkpointRoot: paths.checkpoints,
  skillsDir: paths.skills,
  // Commands are resolved from PATH here (npx → npx.cmd on Windows), like every program mooch starts.
  mcpServers: () => toEngineServers(readMcpConfig(paths.mcp).servers, (command) => (path.isAbsolute(command) ? command : (findExecutable(command) ?? command))),
  onAllowTool: (server, tool) => {
    const { servers } = readMcpConfig(paths.mcp);
    const entry = servers.find((s) => s.name === server);
    if (!entry || entry.alwaysAllow?.includes(tool)) return;
    entry.alwaysAllow = [...(entry.alwaysAllow ?? []), tool];
    writeMcpConfig(paths.mcp, servers);
  },
  prompts: new PromptLibrary(path.join(appRoot, 'prompts')),
  settings,
  emit: (event: AgentEvent) => {
    agentEvents.push(event);
    recorder.onEvent(event);
  },
});
const sessions = new SessionStore(paths.sessions);
const recorder = new SessionRecorder(sessions, () => agentEvents.history(), () => ({ cwd: workspace?.root, mode: agent.mode }));

fcc.on('status', (status: FccStatus) => {
  if (status.state === 'error') log(`[gateway] ${status.message ?? 'error'}`);
  send('fcc:status', status);
});
// The gateway retries slow providers itself; the agent only sees a long silence, so relay retries to the panel.
fcc.on('retry', (message: string) => agentEvents.push({ kind: 'error', message, willRetry: true }));
fcc.on('log', (line: string) => log(`[gateway] ${line}`));

/** Only our own window may call the privileged API. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const trusted = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
  if (!trusted || event.sender !== mainWindow?.webContents) throw new Error('Untrusted IPC sender');
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrusted(event);
    return fn(...args);
  });
}

function text(value: unknown, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid argument.');
  return value;
}

const DECISIONS = new Set<ApprovalDecision>(['accept', 'acceptForSession', 'decline', 'cancel']);
const MODES = new Set(['ask', 'auto-edit', 'full-auto']);

/** A skill to run with a message must be one that is installed (its SKILL.md path is checked). */
function validSkill(value: unknown): { name: string; path: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { name } = value as { name?: unknown };
  if (typeof name !== 'string') return undefined;
  const found = new SkillManager(paths.skills).list(workspace?.root).find((s) => s.name === name);
  return found ? { name: found.name, path: found.path } : undefined;
}

function requireWorkspace(): Workspace {
  if (!workspace) throw new Error('Open a folder first.');
  return workspace;
}

function openWorkspace(root: string): string {
  workspace?.dispose();
  workspace = new Workspace(root, (paths) => send('workspace:changed', paths));
  workspace.startWatching();
  agent.setWorkspace(workspace.root);
  return workspace.root;
}

/** `<app> <folder>` opens that folder. */
function folderFromArgs(argv: string[]): string | undefined {
  for (const arg of argv.slice(1).reverse()) {
    if (arg.startsWith('-') || arg === '.') continue;
    try {
      if (statSync(arg).isDirectory() && path.resolve(arg) !== appRoot) return path.resolve(arg);
    } catch {
      // not a path
    }
  }
  return undefined;
}

handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return openWorkspace(result.filePaths[0]);
});
handle('workspace:current', () => workspace?.root ?? null);
handle('workspace:list', (dir: unknown) => requireWorkspace().list(text(dir, 4096)));
handle('workspace:read', (file: unknown) => requireWorkspace().read(text(file, 4096)));
handle('workspace:write', (file: unknown, content: unknown) => requireWorkspace().write(text(file, 4096), text(content, 50 * 1024 * 1024)));

handle('fcc:status', () => fcc.getStatus());
handle('fcc:restart', () => fcc.restart());
handle('fcc:models', () => fcc.modelList());
handle('fcc:openAdmin', () => openAdmin());
handle('fcc:providers', () => {
  if (!fcc.url || fcc.getStatus().state !== 'running') throw new Error('The model gateway is not running yet.');
  return listProviders(fcc.url);
});
handle('fcc:saveKey', async (providerId: unknown, apiKey: unknown) => {
  if (!fcc.url || fcc.getStatus().state !== 'running') throw new Error('The model gateway is not running yet.');
  const result = await saveProviderKey(fcc.url, text(providerId, 100), text(apiKey, 4096));
  if (result.ok && result.restartRequired) await fcc.restart();
  // The model list depends on which providers have keys.
  if (result.ok) send('fcc:status', fcc.getStatus());
  return result;
});

handle('agent:newThread', (options: NewThreadOptions) => {
  if (!options || typeof options.model !== 'string' || !MODES.has(options.mode)) throw new Error('Invalid chat options.');
  return agent.newThread({ model: options.model, mode: options.mode });
});
handle('agent:send', (message: unknown, options?: SendOptions) =>
  agent.send(text(message, 200_000), { race: options?.race === true, raceConsent: options?.raceConsent === true,deep: options?.deep === true, skill: validSkill(options?.skill), openFiles: Array.isArray(options?.openFiles) ? options.openFiles.filter((f) => typeof f === 'string').slice(0, 50) : undefined }),
);
handle('agent:racePlan', () => agent.racePlan());
handle('agent:applyRace', (raceId: unknown, contestantId: unknown) => agent.applyRace(text(raceId, 100), text(contestantId, 100)));
handle('agent:discardRace', (raceId: unknown) => agent.discardRace(text(raceId, 100)));
handle('agent:previewRestore', (pointId: unknown) => agent.previewRestore(text(pointId, 100)));
handle('agent:restore', (pointId: unknown, rewind: unknown) => agent.restore(text(pointId, 100), rewind === true));
handle('agent:interrupt', () => agent.interrupt());
handle('agent:history', () => agentEvents.history());
handle('agent:update', (update: unknown) => {
  const u = (update && typeof update === 'object' ? update : {}) as Record<string, unknown>;
  const model = typeof u.model === 'string' && u.model.length < 300 ? u.model : undefined;
  const mode = MODES.has(u.mode as string) ? (u.mode as NewThreadOptions['mode']) : undefined;
  return agent.updateChat({ ...(model ? { model } : {}), ...(mode ? { mode } : {}) });
});
handle('agent:compact', () => agent.compact());
handle('agent:review', () => agent.reviewChanges());
handle('agent:respond', (requestId: unknown, decision: unknown, content?: unknown) => {
  if ((typeof requestId !== 'string' && typeof requestId !== 'number') || !DECISIONS.has(decision as ApprovalDecision)) throw new Error('Invalid answer.');
  const fields =
    content && typeof content === 'object' && !Array.isArray(content)
      ? Object.fromEntries(Object.entries(content as Record<string, unknown>).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 50))
      : undefined;
  agent.respond(requestId, decision as ApprovalDecision, fields);
});

handle('mcp:list', async () => {
  const { servers, error } = readMcpConfig(paths.mcp);
  const status = await agent.mcpStatus().catch(() => undefined);
  const views: McpServerView[] = servers.map((server) => {
    const s = status?.find((x) => x.name === server.name);
    const runtime = s?.runtimeStatus;
    const state: McpServerView['state'] = server.disabled
      ? 'off'
      : !status
        ? 'unknown'
        : runtime === 'connected'
          ? 'ready'
          : runtime === 'authenticationRequired' || s?.authStatus === 'notLoggedIn'
            ? 'needsLogin'
            : runtime === 'failed' || s?.toolsError
              ? 'failed'
              : 'starting';
    const tools = Object.values(s?.tools ?? {}).flatMap((t) => (t ? [{ name: t.name, description: t.description ?? undefined, readOnly: (t.annotations as { readOnlyHint?: boolean } | null)?.readOnlyHint === true }] : []));
    return { ...server, state, error: s?.toolsError ?? undefined, tools };
  });
  return { servers: views, error, engineRunning: !!status };
});
handle('mcp:save', async (list: unknown) => {
  if (!Array.isArray(list) || list.length > 100) throw new Error('Invalid server list.');
  const servers = list.map((raw) => {
    const entry = normalizeServer(String((raw as { name?: unknown })?.name ?? ''), raw);
    if (!entry) throw new Error('A server needs a name and a command or URL.');
    const problem = validateServer(entry);
    if (problem) throw new Error(`${entry.name}: ${problem}`);
    return entry;
  });
  if (new Set(servers.map((s) => s.name)).size !== servers.length) throw new Error('Two servers have the same name.');
  writeMcpConfig(paths.mcp, servers);
  await agent.reloadMcp();
});
handle('mcp:parse', (json: unknown) => {
  try {
    return parseMcpJson(text(json, 200_000));
  } catch {
    throw new Error('That is not valid JSON.');
  }
});
handle('mcp:importable', () => findImportableServers());
handle('mcp:login', async (name: unknown) => {
  const url = await agent.mcpLogin(text(name, 100));
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url)) throw new Error('The server gave an unsafe sign-in link.');
  await shell.openExternal(url);
});
handle('mcp:openFile', async () => {
  if (!existsSync(paths.mcp)) writeMcpConfig(paths.mcp, []);
  await shell.openPath(paths.mcp);
});

const skills = new SkillManager(paths.skills);
handle('skills:list', () => skills.list(workspace?.root));
handle('skills:prepare', async (source: unknown) => {
  const s = (source && typeof source === 'object' ? source : {}) as { kind?: unknown; url?: unknown };
  if (s.kind === 'github') return skills.prepare({ kind: 'github', url: text(s.url, 2000) });
  if (s.kind === 'import') return skills.prepare({ kind: 'import' });
  if (s.kind !== 'folder' && s.kind !== 'zip') throw new Error('Invalid skill source.');
  // The file comes from a picker the user drives, never from the window.
  const picked = await dialog.showOpenDialog(mainWindow!, s.kind === 'folder' ? { title: 'Pick a skill folder', properties: ['openDirectory'] } : { title: 'Pick a skill .zip', properties: ['openFile'], filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return skills.prepare({ kind: s.kind, path: picked.filePaths[0] });
});
handle('skills:install', async (token: unknown, names: unknown, replace: unknown) => {
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error('Invalid skills.');
  const installed = skills.install(text(token, 100), names as string[], replace === true);
  await agent.reloadSkills();
  return installed;
});
handle('skills:discard', (token: unknown) => skills.discard(text(token, 100)));
handle('skills:remove', async (name: unknown) => {
  skills.remove(text(name, 100));
  await agent.reloadSkills();
});
handle('skills:openFolder', async () => {
  mkdirSync(paths.skills, { recursive: true });
  await shell.openPath(paths.skills);
});

handle('commands:list', () => loadCustomCommands(paths.commands, workspace?.root));
handle('commands:openFolder', async () => {
  mkdirSync(paths.commands, { recursive: true });
  await shell.openPath(paths.commands);
});
handle('sessions:list', () => sessions.list());
handle('sessions:search', (query: unknown) => sessions.search(text(query, 500)));
handle('sessions:read', (id: unknown) => {
  if (!isSessionId(id)) throw new Error('Invalid session.');
  return sessions.read(id);
});
handle('sessions:rename', (id: unknown, title: unknown) => {
  if (!isSessionId(id)) throw new Error('Invalid session.');
  return sessions.rename(id, text(title, 500));
});
handle('sessions:delete', async (id: unknown) => {
  if (!isSessionId(id)) throw new Error('Invalid session.');
  if (recorder.currentId === id) throw new Error('This chat is open. Start a new chat first.');
  // The engine's copy is removed too when it can be; mooch's log and index entry always are.
  await agent.deleteThread(id).catch((error: Error) => log(`[sessions] engine delete failed: ${error.message}`));
  sessions.remove(id);
});
handle('sessions:resume', async (id: unknown, model: unknown) => {
  if (!isSessionId(id)) throw new Error('Invalid session.');
  const summary = sessions.get(id);
  if (!summary) throw new Error('That chat is no longer saved.');
  if (!existsSync(summary.cwd) || !statSync(summary.cwd).isDirectory()) throw new Error(`Its project folder is gone: ${summary.cwd}`);
  const previousRoot = workspace?.root;
  const switching = path.resolve(summary.cwd).toLowerCase() !== path.resolve(previousRoot ?? '').toLowerCase();
  if (switching) openWorkspace(summary.cwd);
  const log = sessions.read(id);
  // A model that is no longer available is replaced by the one picked in the window.
  const chosen = typeof model === 'string' && model.length < 300 ? model : summary.model;
  const undoRecorder = recorder.resume(summary);
  try {
    await agent.resumeThread(id, { model: chosen, mode: summary.mode }, log);
  } catch (error) {
    // The window still shows the previous chat, so the main process goes back to it too: its folder,
    // and its log (otherwise its next messages would be saved over the chat that failed to open).
    undoRecorder();
    if (switching && previousRoot) openWorkspace(previousRoot);
    throw error;
  }
  agentEvents.replaceHistory(log);
  return { workspace: workspace!.root, model: chosen, mode: summary.mode };
});

handle('settings:get', () => settings.get());
handle('settings:update', (patch: unknown) => {
  const next = settings.update(patch);
  applyTheme();
  return next;
});
handle('settings:team', (executor: unknown) => agent.resolveTeam(text(executor, 200)));

handle('app:about', (): AboutInfo => {
  let notices = '';
  try {
    notices = readFileSync(path.join(resources, 'notices', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  } catch {
    // generated by `npm run stage`; absent in a plain development checkout
  }
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    codexVersion: versions.codex,
    gatewayVersion: versions.gateway,
    dataFolder: paths.home,
    runtimeFolder,
    notices,
  };
});
handle('app:openExternal', (url: unknown) => {
  const target = new URL(text(url, 2048));
  if (target.protocol !== 'https:') throw new Error('Only https links can be opened.');
  return shell.openExternal(target.toString());
});
handle('app:removeRuntime', async () => {
  if (!runtimeFolder) throw new Error('Development builds use the gateway checkout instead.');
  agent.dispose();
  await fcc.stop();
  await rm(runtimeFolder, { recursive: true, force: true, maxRetries: 3 });
  log(`[runtime] removed ${runtimeFolder}`);
});
handle('app:openDataFolder', () => shell.openPath(paths.home).then(() => undefined));

/** The gateway's own settings page, for options mooch doesn't show itself. */
function openAdmin(): void {
  if (!fcc.url) return;
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    parent: mainWindow ?? undefined,
    title: 'Advanced gateway settings',
    backgroundColor: themeBackground(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  adminWindow.setMenuBarVisibility(false);
  const adminOrigin = new URL(fcc.url).origin;
  adminWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== adminOrigin) event.preventDefault();
  });
  void adminWindow.loadURL(`${fcc.url}/admin`);
  // Model choices may have changed; let the window re-read the catalog.
  adminWindow.on('closed', () => send('fcc:status', fcc.getStatus()));
}

/** The window background behind the page, matching the chosen theme (Night or Day when following Windows). */
function themeBackground(): string {
  return resolveTheme(settings.get().theme, nativeTheme.shouldUseDarkColors).colors.bg;
}

/** The title bar and native menus follow the theme: the system's own setting, or the theme's dark/light side. */
function applyTheme(): void {
  const setting = settings.get().theme;
  nativeTheme.themeSource = setting === 'system' ? 'system' : resolveTheme(setting, false).dark ? 'dark' : 'light';
  for (const win of [mainWindow, adminWindow]) if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground());
}

/** .ico on Windows, .png on Linux; macOS uses the app bundle's icon. */
function windowIcon(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const file = path.join(resources, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return existsSync(file) ? file : undefined;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    backgroundColor: themeBackground(),
    ...(windowIcon() ? { icon: windowIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  const contents = mainWindow.webContents;
  contents.on('did-start-loading', () => (rendererReady = false));
  contents.on('did-finish-load', () => (rendererReady = true));
  let recoveries = 0;
  contents.on('render-process-gone', (_event, details) => {
    rendererReady = false;
    log(`[window] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason === 'clean-exit' || recoveries >= 3) return;
    // The agent, the gateway and the chat live in this process, so a reload loses nothing: the page
    // rebuilds its transcript from agent:history.
    recoveries++;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 500);
  });
  contents.on('unresponsive', () => log('[window] renderer is not responding'));
  if (DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Every window, including ones nobody expects: no pop-ups, no <webview>, links open in the browser.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const folder = folderFromArgs(argv);
  if (folder) {
    openWorkspace(folder);
    void mainWindow.webContents.reload();
  }
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  // Nothing in the app needs the camera, microphone, notifications or similar.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  log(`[start] ${APP_NAME} ${app.getVersion()} (${dev ? 'development' : 'installed'})`);
  if (carriedOver.length) log(`[start] carried over into ${paths.home}: ${carriedOver.join(', ')}`);
  // Race copies only live while a race is open; anything here was left by a crash. Their dependency
  // folders are links into the user's projects, so delete without following links.
  void removeTreeNoFollow(raceRoot).catch((error: Error) => log(`[races] cleanup failed: ${error.message}`));
  const initialFolder = folderFromArgs(process.argv);
  if (initialFolder) openWorkspace(initialFolder);
  applyTheme();
  nativeTheme.on('updated', () => {
    for (const win of [mainWindow, adminWindow]) if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground());
  });
  createWindow();
  fcc.start().catch((error: Error) => log(`[gateway] start failed: ${error.message}`));
});

app.on('window-all-closed', () => app.quit());
// Ctrl+C in a terminal (npm run dev) or a polite kill: shut down through before-quit, which stops the gateway.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

let quitting = false;
app.on('before-quit', (event) => {
  recorder.flush();
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  agent.dispose();
  workspace?.dispose();
  void fcc.stop().finally(() => app.quit());
});
