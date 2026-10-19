import { create } from 'zustand';
import type { AgentEvent, ApprovalDecision, ApprovalMode, CustomCommand, InstalledSkill, FccStatus, FreeCodeSettings, ModelOption, ResolvedTeam, ServiceState } from '../shared/ipc';
import { shortModelName } from '../shared/modelNames';
import { THEMES, type ThemeInfo } from '../shared/themes';
import { api, errorMessage } from './api';
import { BUILT_INS, expandTemplate, findCommand, findModel, INIT_PROMPT, parseMode, parseSlash, type SlashCommand } from './slashCommands';
import { addInfo, applyEvent, emptyTranscript, markApproval, type TranscriptState } from './transcript';

export type Tab =
  | { kind: 'file'; id: string; path: string; title: string; content: string; saved: string }
  | { kind: 'diff'; id: string; title: string; diff: string; path: string };

export type SettingsPage = 'providers' | 'chat' | 'skills' | 'integrations' | 'appearance' | 'about' | 'acknowledgements';

interface AppState {
  workspace: string | null;
  fcc: FccStatus;
  codex: ServiceState;
  codexMessage?: string;
  models: ModelOption[];
  model: string;
  mode: ApprovalMode;
  transcript: TranscriptState;
  notice?: string;
  tabs: Tab[];
  activeTab?: string;
  treeVersion: number;
  /** Time of the last agent event, to show how long we've been waiting on the model. */
  lastActivity: number;
  /** Models that failed or stalled recently → until when (epoch ms), for the model picker. */
  busyUntil: Record<string, number>;
  settings?: FreeCodeSettings;
  /** The theme in use (the chosen one, or Night/Day when following Windows). */
  theme: ThemeInfo;
  team?: ResolvedTeam;
  /** The session browser is open. */
  sessionsOpen: boolean;
  setSessionsOpen(open: boolean): void;
  /** Continues a saved chat, switching to its folder when it ran somewhere else. */
  resumeSession(id: string): Promise<void>;
  /** The open Settings page, or undefined when Settings is closed. */
  settingsPage?: SettingsPage;
  setSettingsPage(page?: SettingsPage): void;

  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<FreeCodeSettings>): Promise<void>;
  loadTeam(): Promise<void>;
  race(text: string): Promise<void>;
  /** A race waiting for the user's OK (outside Full auto, races don't ask before running things). */
  raceConsent?: { text: string; testCommand?: string };
  confirmRace(): Promise<void>;
  cancelRace(): void;
  /** Text to put back in the input box after a rewind. */
  draftRequest?: string;
  restore(pointId: string, rewind: boolean): Promise<void>;
  undoRestore(entryId: string, undoPointId: string): Promise<void>;
  applyRace(raceId: string, contestantId: string): Promise<void>;
  discardRace(raceId: string): Promise<void>;

  openFolder(): Promise<void>;
  loadModels(): Promise<void>;
  setModel(model: string): void;
  /** When the picker last changed by itself (the chat moved to a backup model), to draw the eye to it. */
  modelFlash?: number;
  /** Sends the last message again, optionally on another model first ("Try again", "Use X"). */
  retryLast(model?: string): Promise<void>;
  setMode(mode: ApprovalMode): void;
  newChat(): Promise<void>;
  send(text: string, options?: { deep?: boolean; skill?: { name: string; path: string } }): Promise<void>;
  /** Custom commands for the open project (~/.mooch/commands, .mooch/commands). */
  customCommands: CustomCommand[];
  /** Installed skills, also offered as /skill-name. */
  skills: InstalledSkill[];
  loadCommands(): Promise<void>;
  /** Built-ins, then custom commands, for the / menu. */
  commands(): SlashCommand[];
  /** Runs `/name args`: "ran", "rejected" (a notice says why; keep the text to fix it), or false when the text isn't a command. */
  runCommand(text: string): Promise<'ran' | 'rejected' | false>;
  stop(): Promise<void>;
  answer(requestId: string | number, decision: ApprovalDecision, content?: Record<string, unknown>): Promise<void>;
  onAgentEvent(event: AgentEvent): void;
  replayAgentEvents(events: AgentEvent[]): void;
  openFile(path: string): Promise<void>;
  openDiff(path: string, diff: string): void;
  editTab(id: string, content: string): void;
  saveTab(id: string): Promise<void>;
  closeTab(id: string): void;
  onFilesChanged(paths: string[]): Promise<void>;
  setNotice(notice?: string): void;
}

const MODEL_KEY = 'mooch.model';

// Per-machine convenience only; the app works the same if storage is unavailable.
function readPreference(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export const useApp = create<AppState>((set, get) => ({
  workspace: null,
  fcc: { state: 'stopped' },
  codex: 'stopped',
  models: [],
  model: '',
  mode: 'ask',
  transcript: emptyTranscript,
  tabs: [],
  treeVersion: 0,
  lastActivity: 0,
  busyUntil: {},
  theme: THEMES[0],
  sessionsOpen: false,
  customCommands: [],
  skills: [],

  setSessionsOpen(sessionsOpen) {
    set({ sessionsOpen });
  },

  async resumeSession(id) {
    if (get().transcript.running) {
      set({ notice: 'Stop Penny before switching chats.' });
      return;
    }
    try {
      const saved = (await api.sessions.list()).find((s) => s.id === id);
      // Keep the chat's own model when it's still offered; otherwise continue with the one picked now.
      const model = saved && get().models.some((m) => m.slug === saved.model) ? saved.model : get().model;
      const result = await api.sessions.resume(id, model);
      if (result.workspace !== get().workspace) {
        set({ workspace: result.workspace, tabs: [], activeTab: undefined, treeVersion: get().treeVersion + 1 });
      }
      set({ model: result.model, mode: result.mode, sessionsOpen: false, notice: undefined });
      get().replayAgentEvents(await api.agent.history());
      // A chat saved mid-turn (the app was closed) is not running now.
      set({ transcript: { ...get().transcript, running: false, retrying: undefined } });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  setSettingsPage(settingsPage) {
    set({ settingsPage });
  },

  async openFolder() {
    const folder = await api.workspace.open();
    if (!folder) return;
    set({ workspace: folder, tabs: [], activeTab: undefined, transcript: emptyTranscript, treeVersion: get().treeVersion + 1 });
  },

  async loadModels() {
    const { models, defaultModel } = await api.fcc.models();
    const preferred = [get().model, readPreference(MODEL_KEY)].find((slug) => slug && models.some((m) => m.slug === slug));
    set({ models, model: preferred ?? defaultModel });
    await get().loadTeam();
  },

  setModel(model) {
    writePreference(MODEL_KEY, model);
    // The open chat's model changes too, so the status bar says who answers next.
    const transcript = get().transcript;
    set({ model, transcript: transcript.threadId ? { ...transcript, model } : transcript });
    void get().loadTeam();
    // An open chat switches from the next message on.
    if (get().transcript.threadId) void api.agent.update({ model }).catch((error) => set({ notice: errorMessage(error) }));
  },

  async loadSettings() {
    set({ settings: await api.settings.get() });
  },

  async updateSettings(patch) {
    set({ settings: await api.settings.update(patch) });
    if (patch.theme) (await import('./theme')).applyTheme(patch.theme);
    if (patch.team) await get().loadTeam();
  },

  async loadTeam() {
    if (get().model) set({ team: await api.settings.team(get().model) });
  },

  async race(text) {
    try {
      if (!get().transcript.threadId) await get().newChat();
      if (!get().transcript.threadId) return;
      const plan = await api.agent.racePlan();
      if (plan.needsConsent) {
        set({ raceConsent: { text, testCommand: plan.testCommand } });
        return;
      }
      await api.agent.send(text, { race: true });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  async confirmRace() {
    const consent = get().raceConsent;
    if (!consent) return;
    set({ raceConsent: undefined });
    await api.agent.send(consent.text, { race: true, raceConsent: true }).catch((error) => set({ notice: errorMessage(error) }));
  },

  cancelRace() {
    // The request goes back in the input box, to send normally or race later.
    set({ draftRequest: get().raceConsent?.text, raceConsent: undefined });
  },

  async restore(pointId, rewind) {
    try {
      const result = await api.agent.restore(pointId, rewind);
      if (result.message) set({ draftRequest: result.message });
      await get().onFilesChanged(result.files.map((f) => f.path));
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  async undoRestore(entryId, undoPointId) {
    try {
      const result = await api.agent.restore(undoPointId, false);
      const transcript = get().transcript;
      // Mark the original card as undone; the reducer already appended a card for this restore.
      set({
        transcript: {
          ...transcript,
          entries: transcript.entries
            .filter((e) => !(e.type === 'restored' && e.result.undoPointId === result.undoPointId))
            .map((e) => (e.id === entryId && e.type === 'restored' ? { ...e, undone: true } : e)),
        },
      });
      await get().onFilesChanged(result.files.map((f) => f.path));
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  async applyRace(raceId, contestantId) {
    await api.agent.applyRace(raceId, contestantId).catch((error) => set({ notice: errorMessage(error) }));
  },

  async discardRace(raceId) {
    await api.agent.discardRace(raceId).catch((error) => set({ notice: errorMessage(error) }));
  },

  setMode(mode) {
    set({ mode });
    if (get().transcript.threadId) void api.agent.update({ mode }).catch((error) => set({ notice: errorMessage(error) }));
  },

  async loadCommands() {
    const [customCommands, skills] = await Promise.all([api.commands.list().catch(() => []), api.skills.list().catch(() => [])]);
    set({ customCommands, skills });
  },

  commands() {
    const builtIns = new Set(BUILT_INS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const custom: SlashCommand[] = get()
      .customCommands.filter((c) => !builtIns.has(c.name))
      .map((c) => ({ name: c.name, args: c.body.includes('$ARGUMENTS') ? '<text>' : undefined, description: c.description, kind: 'custom', body: c.body }));
    const taken = new Set([...builtIns, ...custom.map((c) => c.name)]);
    const skills: SlashCommand[] = get()
      .skills.filter((s) => !taken.has(s.name.toLowerCase()))
      .map((s) => ({ name: s.name.toLowerCase(), args: '[what to do]', description: s.description, kind: 'skill', path: s.path }));
    return [...BUILT_INS, ...custom, ...skills];
  },

  async runCommand(text) {
    const parsed = parseSlash(text);
    if (!parsed) return false;
    const all = get().commands();
    const command = findCommand(all, parsed.name);
    const info = (markdown: string) => set({ transcript: addInfo(get().transcript, markdown) });
    let rejected = false;
    const fail = (notice: string) => {
      rejected = true;
      set({ notice });
    };
    if (!command) {
      fail(`There's no /${parsed.name} command. Type / to see them all, or start with a space to send it as a message.`);
      return 'rejected';
    }
    const { args } = parsed;
    if (command.needsArgs && !args) {
      fail(`/${command.name} needs ${command.args}, e.g. /${command.name} fix the failing test.`);
      return 'rejected';
    }
    if (command.kind === 'custom') {
      await get().send(expandTemplate(command.body ?? '', args));
      return 'ran';
    }
    if (command.kind === 'skill') {
      await get().send(args || `Use the ${command.name} skill.`, { skill: { name: command.name, path: command.path ?? '' } });
      return 'ran';
    }
    try {
      switch (command.name) {
        case 'help':
          info(['**Commands**', '', '| | |', '|---|---|', ...all.map((c) => `| \`/${c.name}${c.args ? ' ' + c.args : ''}\` | ${c.description}${c.kind === 'custom' ? ' *(yours)*' : ''} |`)].join('\n'));
          break;
        case 'new':
          await get().newChat();
          break;
        case 'resume':
          get().setSessionsOpen(true);
          break;
        case 'compact':
          await api.agent.compact();
          break;
        case 'model': {
          const slugs = get().models.map((m) => m.slug);
          if (!args) {
            info(`Using **${shortModelName(get().model)}**. Pick another with \`/model <name>\`, e.g. \`/model ${shortModelName(slugs.find((m) => m !== get().model) ?? 'glm')}\`.`);
            break;
          }
          const slug = findModel(slugs, args);
          if (!slug) {
            fail(`No model matches "${args}". Open the model picker to see them all.`);
            break;
          }
          get().setModel(slug);
          info(`Switched to **${shortModelName(slug)}**${get().transcript.threadId ? ' from your next message' : ''}.`);
          break;
        }
        case 'mode': {
          const mode = parseMode(args);
          if (!mode) {
            fail('Use /mode ask, /mode auto or /mode full.');
            break;
          }
          get().setMode(mode);
          info(`Permissions: **${{ ask: 'Ask first', 'auto-edit': 'Auto-edit', 'full-auto': 'Full auto' }[mode]}**${get().transcript.threadId ? ' from your next message' : ''}.`);
          break;
        }
        case 'undo':
        case 'rewind': {
          const rewind = command.name === 'rewind';
          const points = get().transcript.entries.flatMap((e) => (e.type === 'point' && e.point.reason === 'message' && (!rewind || e.point.canRewind) ? [e.point] : []));
          const point = points.at(-1);
          if (!point) {
            fail(rewind ? 'Nothing to rewind in this chat yet.' : 'No restore point in this chat yet.');
            break;
          }
          await get().restore(point.id, rewind);
          break;
        }
        case 'review':
          set({ transcript: { ...get().transcript, running: true }, lastActivity: Date.now() });
          await api.agent.review();
          break;
        case 'deep':
          await get().send(args, { deep: true });
          break;
        case 'race':
          await get().race(args);
          break;
        case 'init':
          await get().send(INIT_PROMPT);
          break;
        case 'usage': {
          const usage = get().transcript.tokenUsage;
          info(
            usage
              ? `This chat: **${usage.total.totalTokens.toLocaleString()}** tokens (${usage.total.inputTokens.toLocaleString()} in, ${usage.total.outputTokens.toLocaleString()} out). The last step sent ${usage.last.inputTokens.toLocaleString()} tokens of context. Cost: **$0.00**, still.`
              : 'Nothing used yet in this chat. Cost so far: **$0.00**.',
          );
          break;
        }
        case 'theme':
          get().setSettingsPage('appearance');
          break;
        case 'skills':
          get().setSettingsPage('skills');
          break;
        case 'mcp':
          get().setSettingsPage('integrations');
          break;
        case 'commands':
          await api.commands.openFolder();
          info('Your commands folder is open. Each `name.md` file there becomes `/name`: its text is sent as the message, with `$ARGUMENTS` replaced by what you type after the command. Add `description: …` between `---` lines at the top to describe it. A project can have its own in `.mooch/commands`.');
          break;
      }
    } catch (error) {
      set({ notice: errorMessage(error), transcript: { ...get().transcript, running: false } });
      return 'rejected';
    }
    return rejected ? 'rejected' : 'ran';
  },

  async newChat() {
    const { model, mode } = get();
    if (!model) {
      set({ notice: 'No model available yet. Add a free key in Settings > Models & providers.', settingsPage: 'providers' });
      return;
    }
    try {
      set({ transcript: emptyTranscript, notice: undefined });
      await api.agent.newThread({ model, mode });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  async retryLast(model) {
    const last = [...get().transcript.entries].reverse().find((e) => e.type === 'user');
    if (!last || last.type !== 'user' || get().transcript.running) return;
    if (model && model !== get().model) {
      writePreference(MODEL_KEY, model);
      set({ model, modelFlash: Date.now(), transcript: { ...get().transcript, model } });
      void get().loadTeam();
      // Applied before the message goes out, so the retry already uses the new model.
      await api.agent.update({ model }).catch((error) => set({ notice: errorMessage(error) }));
    }
    await get().send(last.text);
  },

  async send(text, options = {}) {
    try {
      if (!get().transcript.threadId) await get().newChat();
      if (!get().transcript.threadId) return;
      set({ transcript: { ...get().transcript, running: true }, lastActivity: Date.now() });
      const openFiles = get().tabs.flatMap((tab) => (tab.kind === 'file' ? [tab.path] : []));
      await api.agent.send(text, { openFiles, deep: options.deep, skill: options.skill });
    } catch (error) {
      set({ notice: errorMessage(error), transcript: { ...get().transcript, running: false } });
    }
  },

  async stop() {
    await api.agent.interrupt().catch((error) => set({ notice: errorMessage(error) }));
  },

  async answer(requestId, decision, content) {
    set({ transcript: markApproval(get().transcript, requestId, decision) });
    await api.agent.respond(requestId, decision, content);
  },

  onAgentEvent(event) {
    if (event.kind === 'codex') set({ codex: event.state, codexMessage: event.message });
    if (event.kind === 'modelHealth') return void set({ busyUntil: event.busyUntil });
    if (event.kind === 'modelSwitched') {
      // The main process already moved the chat; the picker follows (no update call back), and flashes
      // so the eye connects the divider in the chat to the control that changed.
      writePreference(MODEL_KEY, event.to);
      set({ model: event.to, modelFlash: Date.now() });
      void get().loadTeam();
    }
    // FCC retry notices aren't model output, so they don't count as activity.
    const activity = event.kind === 'error' && event.willRetry ? {} : { lastActivity: Date.now() };
    set({ transcript: applyEvent(get().transcript, event), ...activity });
  },

  replayAgentEvents(events) {
    if (events.length === 0) return;
    let transcript = emptyTranscript;
    let codex: Partial<AppState> = {};
    for (const event of events) {
      transcript = applyEvent(transcript, event);
      if (event.kind === 'codex') codex = { codex: event.state, codexMessage: event.message };
      if (event.kind === 'modelHealth') codex = { ...codex, busyUntil: event.busyUntil };
    }
    set({ transcript, lastActivity: Date.now(), ...codex });
  },

  async openFile(path) {
    const existing = get().tabs.find((tab) => tab.kind === 'file' && tab.path === path);
    if (existing) {
      set({ activeTab: existing.id });
      return;
    }
    try {
      const content = await api.workspace.read(path);
      const tab: Tab = { kind: 'file', id: `file:${path}`, path, title: baseName(path), content, saved: content };
      set({ tabs: [...get().tabs, tab], activeTab: tab.id });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  openDiff(path, diff) {
    const id = `diff:${path}:${diff.length}`;
    if (!get().tabs.some((tab) => tab.id === id)) {
      set({ tabs: [...get().tabs, { kind: 'diff', id, path, diff, title: `Δ ${baseName(path)}` }] });
    }
    set({ activeTab: id });
  },

  editTab(id, content) {
    set({ tabs: get().tabs.map((tab) => (tab.id === id && tab.kind === 'file' ? { ...tab, content } : tab)) });
  },

  async saveTab(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.kind !== 'file') return;
    try {
      await api.workspace.write(tab.path, tab.content);
      set({ tabs: get().tabs.map((t) => (t.id === id && t.kind === 'file' ? { ...t, saved: tab.content } : t)) });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  closeTab(id) {
    const tabs = get().tabs.filter((tab) => tab.id !== id);
    const activeTab = get().activeTab === id ? tabs.at(-1)?.id : get().activeTab;
    set({ tabs, activeTab });
  },

  async onFilesChanged(paths) {
    const root = get().workspace ?? '';
    const absolute = (p: string) => (/^[a-zA-Z]:[\\/]|^\//.test(p) ? p : `${root}\\${p.replace(/\//g, '\\')}`);
    const changed = new Set(paths.map((p) => absolute(p).toLowerCase()));
    // Reload open files the agent changed, unless the user has unsaved edits in them.
    const tabs = await Promise.all(
      get().tabs.map(async (tab) => {
        if (tab.kind !== 'file' || !changed.has(tab.path.toLowerCase()) || tab.content !== tab.saved) return tab;
        try {
          const content = await api.workspace.read(tab.path);
          return content === tab.saved ? tab : { ...tab, content, saved: content };
        } catch {
          return tab; // deleted or unreadable; keep what we have
        }
      }),
    );
    set({ tabs, treeVersion: get().treeVersion + 1 });
  },

  setNotice(notice) {
    set({ notice });
  },
}));
