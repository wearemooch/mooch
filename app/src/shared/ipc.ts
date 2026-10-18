// Contract between the Electron main process and the renderer.
// Protocol types are imported type-only, so nothing from main/ is bundled into the renderer.
import type { ThemeSetting } from './themes';
import type { ThreadItem } from '../main/codex/protocol/v2/ThreadItem';
import type { FileUpdateChange } from '../main/codex/protocol/v2/FileUpdateChange';
import type { ThreadTokenUsage } from '../main/codex/protocol/v2/ThreadTokenUsage';

export type { ThreadItem, FileUpdateChange, ThreadTokenUsage };

export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

export interface FccStatus {
  state: ServiceState;
  url?: string;
  message?: string;
}

/** A model provider, as shown on the Providers settings page. */
export interface ProviderInfo {
  id: string;
  name: string;
  /** Where to get a key (https only). */
  website?: string;
  configured: boolean;
  /** The gateway's own status label, e.g. "Configured" or "Missing key". */
  status: string;
  keyCount: number;
}

export interface ProviderSaveResult {
  ok: boolean;
  message: string;
  restartRequired?: boolean;
}

/** Version and attribution details for Settings > About and Acknowledgements. */
export interface AboutInfo {
  name: string;
  version: string;
  electron: string;
  chromium: string;
  node: string;
  codexVersion: string;
  gatewayVersion: string;
  dataFolder: string;
  /** Where the model gateway's Python runtime lives (installed builds), removed by the uninstaller. */
  runtimeFolder?: string;
  /** Full third-party license texts (THIRD_PARTY_NOTICES.md), or empty when not bundled. */
  notices: string;
}

export interface ModelOption {
  slug: string;
  displayName: string;
}

export interface ModelList {
  models: ModelOption[];
  defaultModel: string;
}

/** How much the agent may do without asking. Mapped to Codex approval policy + sandbox in main. */
export type ApprovalMode = 'ask' | 'auto-edit' | 'full-auto';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalRequest {
  requestId: string | number;
  /** mcpTool: an integration's tool wants to run. mcpUrl / mcpForm: an integration asks the user something. */
  type: 'command' | 'fileChange' | 'mcpTool' | 'mcpUrl' | 'mcpForm';
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
  /** MCP: the server, and for mcpTool the tool, its description and arguments. */
  server?: string;
  tool?: string;
  description?: string;
  args?: { name: string; value: string }[];
  /** mcpUrl / mcpForm: what the server says, the page to open, the fields to fill in (JSON schema). */
  message?: string;
  url?: string;
  schema?: { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[] }>; required?: string[] };
}

/** Per-role model choices the user pinned in the Team dialog; anything unset is auto-picked. */
export interface TeamSettings {
  reviewer?: string;
  backup?: string;
  judge?: string;
  planners?: string[];
  contestants?: string[];
}

export interface FreeCodeSettings {
  /** Second-model review after turns that edit files. */
  review: boolean;
  /** Plan council before each message ("Deep thinking"). */
  deep: boolean;
  /** Send slow requests to a backup model too, and keep whichever answers first. */
  hedge: boolean;
  hedgeDelayMs: number;
  /** How models edit files: Codex's apply_patch, mooch's edit_file/write_file, or auto (edit tools for non-OpenAI models). */
  editTool: 'auto' | 'apply_patch' | 'edit_file';
  /** Test command for races; auto-detected when unset. */
  raceTestCommand?: string;
  team: TeamSettings;
  /** App theme; "system" follows Windows between Night and Day. */
  theme: ThemeSetting;
  /** Compact the chat automatically once its context passes this many tokens; 0 = never. */
  autoCompactTokens: number;
}

export interface ResolvedTeam {
  executor: string;
  reviewer?: string;
  backup?: string;
  judge: string;
  planners: string[];
  contestants: string[];
  /** Only one provider is configured, so "different provider" picks fall back to other models. */
  singleProvider: boolean;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface CouncilState {
  id: string;
  phase: 'planning' | 'judging' | 'done' | 'failed';
  planners: { model: string; status: StepStatus; plan?: string; error?: string }[];
  judge: string;
  merged?: string;
  error?: string;
}

export interface ReviewState {
  id: string;
  model: string;
  /** "comments": the reviewer answered without a clear verdict, so nothing was sent back to the agent. */
  phase: 'reviewing' | 'approved' | 'changes' | 'comments' | 'failed';
  text?: string;
}

export interface TestResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
}

export interface ContestantState {
  id: string;
  model: string;
  status: 'starting' | 'working' | 'testing' | 'done' | 'failed';
  lastMessage?: string;
  error?: string;
  changedFiles: string[];
  linesChanged: number;
  /** How long the agent took, used to break ties. */
  durationMs?: number;
  test?: TestResult;
}

export interface RaceState {
  id: string;
  phase: 'preparing' | 'running' | 'testing' | 'decided' | 'applied' | 'discarded' | 'failed';
  testCommand?: string;
  contestants: ContestantState[];
  winnerId?: string;
  error?: string;
  applied?: { written: string[]; deleted: string[]; skipped: string[] };
}

export interface RestorePoint {
  id: string;
  label: string;
  createdAt: number;
  reason: 'message' | 'race' | 'restore';
  /** The user's message this point was taken before (for Rewind, which puts it back in the input box). */
  message?: string;
  /** Rewind is possible: the conversation can be cut back to before this point. */
  canRewind: boolean;
  /** The engine turn of the message this point was taken before; Rewind cuts back to it. */
  turnId?: string;
}

/** A prompt template from ~/.mooch/commands or <project>/.mooch/commands, run as /name. */
export interface CustomCommand {
  name: string;
  description: string;
  /** The message text; $ARGUMENTS is replaced by what follows the command. */
  body: string;
  scope: 'user' | 'project';
}

/** An MCP server from ~/.mooch/mcp.json: a local program (command) or a remote server (url). */
export interface McpServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Tools that never ask for approval. */
  alwaysAllow?: string[];
}

/** A configured server and what the engine reports about it. */
export interface McpServerView extends McpServerEntry {
  state: 'off' | 'starting' | 'ready' | 'failed' | 'needsLogin' | 'unknown';
  error?: string;
  tools: { name: string; description?: string; readOnly: boolean }[];
}

/** A skill found in a source being installed. */
export interface SkillCandidate {
  name: string;
  description: string;
  /** Where it was found (a folder on disk, or in the unpacked download). */
  source: string;
  files: string[];
  fileCount: number;
  /** Contains scripts Penny might run (still only with approval). */
  hasScripts: boolean;
  /** A skill with this name is installed already. */
  exists: boolean;
}

export interface SkillPreparation {
  token: string;
  candidates: SkillCandidate[];
}

export interface InstalledSkill {
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
  dir: string;
  scope: 'user' | 'project';
  hasScripts: boolean;
}

/** A saved chat, as listed in the session browser. */
export interface SessionSummary {
  id: string;
  /** The first message, shortened; can be renamed. */
  title: string;
  /** The project folder the chat ran in. */
  cwd: string;
  model: string;
  mode: ApprovalMode;
  createdAt: number;
  updatedAt: number;
  /** How many messages the user sent. */
  messages: number;
}

export interface RestoreFile {
  path: string;
  action: 'restore' | 'delete' | 'recreate';
}

export interface RestoreResult {
  pointId: string;
  files: RestoreFile[];
  /** Restore point taken just before restoring, so the restore can be undone. */
  undoPointId: string;
  rewound: boolean;
  message?: string;
}

export interface SendOptions {
  /** Run as a race between several agents in copies of the workspace. */
  race?: boolean;
  /** Files open in the editor, included as context for planners. */
  openFiles?: string[];
  /** Deep thinking for this one message, whatever the setting says (/deep). */
  deep?: boolean;
  /** Run this message with a skill (/skill-name). */
  skill?: { name: string; path: string };
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type AgentEvent =
  | { kind: 'codex'; state: ServiceState; message?: string }
  | { kind: 'thread'; threadId: string; model: string }
  | { kind: 'turnStarted'; turnId: string }
  | { kind: 'turnCompleted'; turnId: string; status: string; error?: string }
  | { kind: 'item'; phase: 'started' | 'completed'; item: ThreadItem }
  | { kind: 'agentDelta'; itemId: string; delta: string }
  | { kind: 'reasoningDelta'; itemId: string; delta: string }
  | { kind: 'commandOutput'; itemId: string; delta: string }
  | { kind: 'patchUpdated'; itemId: string; changes: FileUpdateChange[] }
  | { kind: 'tokenUsage'; usage: ThreadTokenUsage }
  | { kind: 'error'; message: string; willRetry: boolean }
  | { kind: 'warning'; message: string }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'approvalResolved'; requestId: string | number }
  /** Transient one-line status, e.g. a hedge or retry notice. */
  | { kind: 'status'; message: string; /** Also keep it in the transcript, once per message. */ note?: boolean }
  | { kind: 'council'; council: CouncilState }
  | { kind: 'review'; review: ReviewState }
  | { kind: 'race'; race: RaceState }
  | { kind: 'restorePoint'; point: RestorePoint }
  | { kind: 'restored'; result: RestoreResult }
  /** Models that failed or stalled recently → when they stop counting as busy (epoch ms). */
  | { kind: 'modelHealth'; busyUntil: Record<string, number> };

export interface NewThreadOptions {
  model: string;
  mode: ApprovalMode;
}

/** The API exposed on window.freeCode by the preload script. */
export interface FreeCodeApi {
  workspace: {
    open(): Promise<string | null>;
    current(): Promise<string | null>;
    list(dir: string): Promise<DirEntry[]>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    onChanged(cb: (paths: string[]) => void): () => void;
  };
  fcc: {
    status(): Promise<FccStatus>;
    restart(): Promise<void>;
    models(): Promise<ModelList>;
    openAdmin(): Promise<void>;
    providers(): Promise<ProviderInfo[]>;
    saveKey(providerId: string, apiKey: string): Promise<ProviderSaveResult>;
    onStatus(cb: (status: FccStatus) => void): () => void;
  };
  app: {
    about(): Promise<AboutInfo>;
    /** Opens an https link in the user's browser. */
    openExternal(url: string): Promise<void>;
    openDataFolder(): Promise<void>;
    /** Stops the model gateway and deletes its Python runtime (it is set up again on the next start). */
    removeRuntime(): Promise<void>;
  };
  agent: {
    newThread(options: NewThreadOptions): Promise<void>;
    send(text: string, options?: SendOptions): Promise<void>;
    interrupt(): Promise<void>;
    /** `content`: the filled-in fields of an integration's form. */
    respond(requestId: string | number, decision: ApprovalDecision, content?: Record<string, unknown>): Promise<void>;
    applyRace(raceId: string, contestantId: string): Promise<void>;
    discardRace(raceId: string): Promise<void>;
    previewRestore(pointId: string): Promise<RestoreFile[]>;
    restore(pointId: string, rewind: boolean): Promise<RestoreResult>;
    /** The current chat's events so far, to rebuild the transcript after a window reload. */
    history(): Promise<AgentEvent[]>;
    /** Changes the open chat's model or permission mode from the next message on. */
    update(update: Partial<NewThreadOptions>): Promise<void>;
    compact(): Promise<void>;
    review(): Promise<void>;
    onEvent(cb: (event: AgentEvent) => void): () => void;
  };
  commands: {
    /** Custom slash commands for the open project. */
    list(): Promise<CustomCommand[]>;
    /** Opens ~/.mooch/commands in the file manager (created if missing). */
    openFolder(): Promise<void>;
  };
  mcp: {
    /** The servers in ~/.mooch/mcp.json with what the engine reports (state, tools). */
    list(): Promise<{ servers: McpServerView[]; error?: string; engineRunning: boolean }>;
    /** Replaces the whole list; the engine reconnects. */
    save(servers: McpServerEntry[]): Promise<void>;
    /** Servers from pasted JSON (any common format). */
    parse(text: string): Promise<McpServerEntry[]>;
    /** Servers configured in Claude Desktop, Claude Code, Cursor or Windsurf. */
    importable(): Promise<(McpServerEntry & { app: string })[]>;
    /** Opens the server's sign-in page in the browser. */
    login(name: string): Promise<void>;
    openFile(): Promise<void>;
  };
  skills: {
    list(): Promise<InstalledSkill[]>;
    /** Unpacks a source and lists the skills in it. Folder and .zip open a file picker. */
    prepare(source: { kind: 'folder' | 'zip' | 'import' } | { kind: 'github'; url: string }): Promise<SkillPreparation | null>;
    install(token: string, names: string[], replace: boolean): Promise<string[]>;
    discard(token: string): Promise<void>;
    remove(name: string): Promise<void>;
    openFolder(): Promise<void>;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    /** Ids of chats containing the text anywhere. */
    search(query: string): Promise<string[]>;
    read(id: string): Promise<AgentEvent[]>;
    rename(id: string, title: string): Promise<SessionSummary | undefined>;
    delete(id: string): Promise<void>;
    /** Continues a saved chat, opening its folder first when needed. */
    resume(id: string, model?: string): Promise<{ workspace: string; model: string; mode: ApprovalMode }>;
  };
  settings: {
    get(): Promise<FreeCodeSettings>;
    update(patch: Partial<FreeCodeSettings>): Promise<FreeCodeSettings>;
    team(executor: string): Promise<ResolvedTeam>;
  };
}
