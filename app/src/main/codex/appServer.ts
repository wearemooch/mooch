// Owns one `codex app-server` process and translates its protocol into AgentEvents for the UI.
// Event and approval handling follows FCC's runtime/codex_protocol.py.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, ApprovalDecision, ApprovalMode, ApprovalRequest, FileUpdateChange } from '../../shared/ipc';
import type { CodexLaunch } from './launch';
import type { ApprovalPolicy, ApprovalQuestion } from './policy';
import { FCC_PROVIDER_ID } from './launch';
import { JsonlRpcConnection, type IncomingRequest, type RequestId } from './jsonl';
import { OutputLimiter } from './outputLimit';
import { APP_NAME } from '../../shared/brand';

/** Reported to the agent engine as the client version (out/main/codex → the app's package.json). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_VERSION: string = require('../../../package.json').version;
import type { InitializeParams } from './protocol/InitializeParams';
import type { AskForApproval } from './protocol/v2/AskForApproval';
import type { SandboxMode } from './protocol/v2/SandboxMode';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { ThreadResumeParams } from './protocol/v2/ThreadResumeParams';
import type { McpServerStatus } from './protocol/v2/McpServerStatus';
import type { ListMcpServerStatusResponse } from './protocol/v2/ListMcpServerStatusResponse';
import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { ItemStartedNotification } from './protocol/v2/ItemStartedNotification';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { AgentMessageDeltaNotification } from './protocol/v2/AgentMessageDeltaNotification';
import type { CommandExecutionOutputDeltaNotification } from './protocol/v2/CommandExecutionOutputDeltaNotification';
import type { FileChangePatchUpdatedNotification } from './protocol/v2/FileChangePatchUpdatedNotification';
import type { ThreadTokenUsageUpdatedNotification } from './protocol/v2/ThreadTokenUsageUpdatedNotification';
import type { TurnStartedNotification } from './protocol/v2/TurnStartedNotification';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';
import type { ErrorNotification } from './protocol/v2/ErrorNotification';
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec';
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse';

export interface ThreadPermissions {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
}

/** The same permissions as approvalSettings(), in the shape turn/start takes for a mid-chat change. */
export function turnPermissions(mode: ApprovalMode): Pick<TurnStartParams, 'approvalPolicy' | 'sandboxPolicy'> {
  return mode === 'full-auto'
    ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
    : { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}

export interface ThreadTools {
  /** Client-implemented tools (mooch's edit_file / write_file). */
  dynamicTools?: DynamicToolSpec[];
}

/** Runs a dynamic tool call. `approve` asks the policy, then the user, before anything is written. */
export type ToolHandler = (
  call: DynamicToolCallParams,
  approve: (question: ApprovalQuestion, display: { itemId: string; change: FileUpdateChange }) => Promise<boolean>,
) => Promise<DynamicToolCallResponse>;

export interface ThreadInstructions {
  /** Replaces the model's base system prompt (mooch's master prompt). */
  base?: string;
  /** Extra situational instructions, e.g. for race contestants. */
  developer?: string;
}


/**
 * Engine errors often carry the gateway's JSON body, sometimes after a prefix like
 * "unexpected status 529 Service Overloaded: {...}". Show just the message inside it.
 */
export function readableError(message: string): string {
  const start = message.indexOf('{');
  if (start < 0) return message;
  try {
    const body = JSON.parse(message.slice(start)) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const inner = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? body.detail);
    return typeof inner === 'string' && inner.trim() ? inner.trim() : message;
  } catch {
    return message;
  }
}

export function approvalSettings(mode: ApprovalMode): ThreadPermissions {
  switch (mode) {
    case 'ask':
      // Codex asks for every write and untrusted command. With "on-request" weak models had to request
      // write access themselves and often gave up; read-only commands are auto-approved by mooch instead.
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
    case 'auto-edit':
      // Not workspace-write: on Windows that sandbox silently becomes read-only. mooch's policy
      // approves edits inside the workspace instead (see policy.ts).
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
    case 'full-auto':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

/** Maps one app-server notification to a UI event, or null when the UI doesn't need it. */
export function mapNotification(method: string, params: unknown): AgentEvent | null {
  switch (method) {
    case 'item/started':
      return { kind: 'item', phase: 'started', item: (params as ItemStartedNotification).item };
    case 'item/completed':
      return { kind: 'item', phase: 'completed', item: (params as ItemCompletedNotification).item };
    case 'item/agentMessage/delta': {
      const p = params as AgentMessageDeltaNotification;
      return { kind: 'agentDelta', itemId: p.itemId, delta: p.delta };
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const p = params as { itemId: string; delta: string };
      return { kind: 'reasoningDelta', itemId: p.itemId, delta: p.delta };
    }
    case 'item/commandExecution/outputDelta': {
      const p = params as CommandExecutionOutputDeltaNotification;
      return { kind: 'commandOutput', itemId: p.itemId, delta: p.delta };
    }
    case 'item/fileChange/patchUpdated': {
      const p = params as FileChangePatchUpdatedNotification;
      return { kind: 'patchUpdated', itemId: p.itemId, changes: p.changes };
    }
    case 'thread/tokenUsage/updated':
      return { kind: 'tokenUsage', usage: (params as ThreadTokenUsageUpdatedNotification).tokenUsage };
    case 'turn/started':
      return { kind: 'turnStarted', turnId: (params as TurnStartedNotification).turn.id };
    case 'turn/completed': {
      const { turn } = params as TurnCompletedNotification;
      return { kind: 'turnCompleted', turnId: turn.id, status: turn.status, error: turn.error ? readableError(turn.error.message) : undefined };
    }
    case 'error': {
      const p = params as ErrorNotification;
      return { kind: 'error', message: readableError(p.error.message), willRetry: p.willRetry };
    }
    case 'serverRequest/resolved':
      return { kind: 'approvalResolved', requestId: (params as { requestId: RequestId }).requestId };
    case 'warning':
    case 'configWarning':
    case 'deprecationNotice': {
      const p = params as { message?: string; summary?: string };
      const message = p.message ?? p.summary;
      // On Linux without a system bubblewrap the engine uses its own bundled copy; nothing to act on.
      if (message && /could not find bubblewrap/i.test(message)) return null;
      return message ? { kind: 'warning', message } : null;
    }
    default:
      return null;
  }
}

export class CodexAppServer {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: JsonlRpcConnection;
  private stderrTail = '';
  private threadId?: string;
  private activeTurnId?: string;
  private readonly openApprovals = new Set<RequestId>();
  private readonly output = new OutputLimiter();

  constructor(
    private readonly launch: CodexLaunch,
    private readonly cwd: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  get running(): boolean {
    return !!this.connection && !this.connection.closed;
  }

  get currentThreadId(): string | undefined {
    return this.threadId;
  }

  async start(): Promise<void> {
    this.emit({ kind: 'codex', state: 'starting' });
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.cwd,
      env: this.launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8000);
    });
    const connection = new JsonlRpcConnection(child.stdout, child.stdin, 'fc');
    this.connection = connection;
    connection.on('notification', (method: string, params: unknown) => this.onNotification(method, params));
    connection.on('request', (request: IncomingRequest) => this.onServerRequest(request));
    connection.on('close', (reason: string) => {
      const tail = this.stderrTail.trim().split('\n').slice(-5).join('\n');
      this.emit({ kind: 'codex', state: 'stopped', message: tail ? `${reason}\n${tail}` : reason });
    });
    child.on('error', (error) => connection.close(`Could not start the agent engine: ${error.message}`));
    child.on('exit', (code) => connection.close(`The agent engine stopped (code ${code ?? 'unknown'}).`));

    const params: InitializeParams = {
      clientInfo: { name: 'mooch', title: APP_NAME, version: APP_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await connection.request('initialize', params);
    connection.notify('initialized', {});
    this.emit({ kind: 'codex', state: 'running' });
  }

  async startThread(model: string, permissions: ThreadPermissions, instructions: ThreadInstructions = {}, tools: ThreadTools = {}): Promise<string> {
    const params: ThreadStartParams = {
      dynamicTools: tools.dynamicTools?.length ? tools.dynamicTools : null,
      cwd: this.cwd,
      modelProvider: FCC_PROVIDER_ID,
      model,
      ...permissions,
      baseInstructions: instructions.base ?? null,
      developerInstructions: instructions.developer ?? null,
    };
    const response = await this.rpc<ThreadStartResponse>('thread/start', params);
    this.turnOverrides = undefined;
    this.threadId = response.thread.id;
    this.activeTurnId = undefined;
    this.emit({ kind: 'thread', threadId: response.thread.id, model: response.model });
    return response.thread.id;
  }

  /** Continues a saved chat: the engine reloads its history from ~/.mooch/engine and answers in this folder. */
  async resumeThread(threadId: string, model: string, permissions: ThreadPermissions, instructions: ThreadInstructions = {}): Promise<string> {
    const params: ThreadResumeParams = {
      threadId,
      cwd: this.cwd,
      modelProvider: FCC_PROVIDER_ID,
      model,
      ...permissions,
      baseInstructions: instructions.base ?? null,
      developerInstructions: instructions.developer ?? null,
    };
    const response = await this.rpc<ThreadResumeResponse>('thread/resume', params);
    this.turnOverrides = undefined;
    this.threadId = response.thread.id;
    this.activeTurnId = undefined;
    this.emit({ kind: 'thread', threadId: response.thread.id, model: response.model });
    return response.thread.id;
  }

  /** Summarizes the chat so far and continues from the summary (the engine's compaction). */
  async compact(): Promise<void> {
    if (!this.threadId) throw new Error('No chat to compact yet.');
    if (this.activeTurnId) throw new Error('Wait for the current step to finish, or stop it, before compacting.');
    await this.rpc('thread/compact/start', { threadId: this.threadId });
  }

  /** The engine's review mode on the project's uncommitted git changes; the findings arrive as items. */
  async reviewUncommitted(): Promise<void> {
    if (!this.threadId) throw new Error('Start a chat first.');
    if (this.activeTurnId) throw new Error('Wait for the current step to finish before reviewing.');
    const response = await this.rpc<{ turn?: { id: string } }>('review/start', { threadId: this.threadId, target: { type: 'uncommittedChanges' }, delivery: 'inline' });
    if (response.turn?.id) this.activeTurnId = response.turn.id;
  }

  /** Removes a saved chat from the engine's store. */
  async deleteThread(threadId: string): Promise<void> {
    await this.rpc('thread/delete', { threadId });
    if (this.threadId === threadId) this.threadId = undefined;
  }

  /** Model and permission changes made mid-chat; sent with every message until the next thread. */
  turnOverrides?: Pick<TurnStartParams, 'model' | 'approvalPolicy' | 'sandboxPolicy'>;

  /** Where the engine finds skills besides its own folder: ~/.mooch/skills and the project's .mooch/skills. */
  async setSkillRoots(roots: string[]): Promise<void> {
    await this.rpc('skills/extraRoots/set', { extraRoots: roots });
    await this.rpc('skills/list', { cwds: [this.cwd], forceReload: true });
  }

  /** Replaces the engine's MCP servers and reconnects them. */
  async configureMcp(servers: Record<string, unknown>): Promise<void> {
    await this.rpc('config/batchWrite', { edits: [{ keyPath: 'mcp_servers', value: servers, mergeStrategy: 'replace' }], reloadUserConfig: true });
    await this.rpc('config/mcpServer/reload', {});
  }

  /** What the engine knows about each MCP server: connection, tools, login. */
  async mcpStatus(): Promise<McpServerStatus[]> {
    const response = await this.rpc<ListMcpServerStatusResponse>('mcpServerStatus/list', { detail: 'full', threadId: this.threadId ?? null });
    return response.data;
  }

  /** Starts an OAuth sign-in for a server; returns the page to open in the browser. */
  async mcpLogin(name: string): Promise<string> {
    const response = await this.rpc<{ authorizationUrl: string }>('mcpServer/oauth/login', { name });
    return response.authorizationUrl;
  }

  /** Turns engine skills off by name (built-ins that only make sense with an OpenAI account). */
  async disableSkills(names: string[]): Promise<void> {
    for (const name of names) await this.rpc('skills/config/write', { name, enabled: false }).catch(() => undefined);
  }

  async sendMessage(text: string, skill?: { name: string; path: string }): Promise<string> {
    if (!this.threadId) throw new Error('No thread has been started.');
    const params: TurnStartParams = {
      threadId: this.threadId,
      input: [...(skill ? [{ type: 'skill' as const, name: skill.name, path: skill.path }] : []), { type: 'text', text, text_elements: [] }],
      ...this.turnOverrides,
    };
    const response = await this.rpc<TurnStartResponse>('turn/start', params);
    this.activeTurnId = response.turn.id;
    return response.turn.id;
  }

  get turnRunning(): boolean {
    return !!this.activeTurnId;
  }

  /** Drops `beforeTurnId` and every later turn from the conversation (files are not touched). */
  async revertConversation(beforeTurnId: string): Promise<void> {
    if (!this.threadId) return;
    await this.rpc('thread/revert', { threadId: this.threadId, beforeTurnId });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
  }

  /** Answers approval requests it can decide; the rest go to the user. */
  policy?: ApprovalPolicy;
  /** Nobody is watching (race contestants): requests the policy can't decide are declined. */
  unattended = false;
  /** Paths each fileChange item touches; approval requests only carry the item id. */
  private readonly patchPaths = new Map<string, string[]>();
  /** Implements dynamic tool calls (mooch's edit tools). */
  toolHandler?: ToolHandler;
  /** Approvals mooch itself is waiting on (for its own edit tools), keyed by synthetic request id. */
  private readonly clientApprovals = new Map<string, (decision: ApprovalDecision) => void>();

  /** Integrations' tools the user allowed for good ("server/tool"); asked about no more. */
  readonly allowedTools = new Set<string>();
  /** Called when the user picks "Always" for an integration's tool, to remember it in mcp.json. */
  onAllowTool?: (server: string, tool: string) => void;
  /** Open MCP elicitations (they are answered with an action, not a decision). */
  private readonly elicitations = new Map<RequestId, { server: string; tool?: string }>();

  /** An integration asks the user something: to run one of its tools, to open a page, or to fill in a form. */
  private onElicitation(request: IncomingRequest): void {
    const p = request.params as McpServerElicitationRequestParams;
    const meta = (p._meta ?? {}) as { codex_approval_kind?: string; tool_description?: string; tool_params_display?: { name: string; display_name?: string; value: unknown }[] };
    const base = { requestId: request.id, itemId: `elicitation-${String(request.id)}`, server: p.serverName };
    if (meta.codex_approval_kind === 'mcp_tool_call') {
      const tool = /tool "([^"]+)"/.exec('message' in p ? p.message : '')?.[1] ?? 'a tool';
      this.elicitations.set(request.id, { server: p.serverName, tool });
      const decision = this.allowedTools.has(`${p.serverName}/${tool}`) ? 'accept' : (this.policy?.({ type: 'mcpTool', server: p.serverName, tool }) ?? (this.unattended ? 'decline' : undefined));
      if (decision) return this.respondToApproval(request.id, decision);
      this.emit({
        kind: 'approval',
        request: {
          ...base,
          type: 'mcpTool',
          tool,
          description: meta.tool_description,
          args: (meta.tool_params_display ?? []).map((a) => ({ name: a.display_name ?? a.name, value: typeof a.value === 'string' ? a.value : JSON.stringify(a.value) })),
        },
      });
      return;
    }
    if (this.unattended) {
      this.connection?.respond(request.id, { action: 'decline', content: null, _meta: null });
      return;
    }
    this.elicitations.set(request.id, { server: p.serverName });
    if (p.mode === 'url') {
      this.emit({ kind: 'approval', request: { ...base, type: 'mcpUrl', message: p.message, url: p.url } });
    } else if (p.mode === 'form') {
      this.emit({ kind: 'approval', request: { ...base, type: 'mcpForm', message: p.message, schema: p.requestedSchema as ApprovalRequest['schema'] } });
    } else {
      this.elicitations.delete(request.id);
      this.connection?.respond(request.id, { action: 'decline', content: null, _meta: null });
    }
  }

  respondToApproval(requestId: RequestId, decision: ApprovalDecision, content?: Record<string, unknown>): void {
    const elicitation = this.elicitations.get(requestId);
    if (elicitation) {
      this.elicitations.delete(requestId);
      const accepted = decision === 'accept' || decision === 'acceptForSession';
      if (decision === 'acceptForSession' && elicitation.tool) {
        this.allowedTools.add(`${elicitation.server}/${elicitation.tool}`);
        this.onAllowTool?.(elicitation.server, elicitation.tool);
      }
      this.connection?.respond(requestId, { action: accepted ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline', content: accepted ? (content ?? {}) : null, _meta: null });
      this.emit({ kind: 'approvalResolved', requestId });
      return;
    }
    const waiting = this.clientApprovals.get(String(requestId));
    if (waiting) {
      this.clientApprovals.delete(String(requestId));
      this.emit({ kind: 'approvalResolved', requestId });
      waiting(decision);
      return;
    }
    if (!this.openApprovals.delete(requestId)) return;
    this.connection?.respond(requestId, { decision });
    this.emit({ kind: 'approvalResolved', requestId });
  }

  stop(): void {
    for (const resolve of this.clientApprovals.values()) resolve('cancel');
    this.clientApprovals.clear();
    this.connection?.close('The agent engine was stopped.');
    if (this.process && this.process.exitCode === null) this.process.kill();
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    if (!this.connection || this.connection.closed) return Promise.reject(new Error('The agent engine is not running.'));
    return this.connection.request<T>(method, params);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') this.activeTurnId = undefined;
    if (method === 'item/started' || method === 'item/completed') {
      const { item } = params as ItemStartedNotification;
      if (item.type === 'fileChange') this.patchPaths.set(item.id, item.changes.map((c) => c.path));
    } else if (method === 'item/fileChange/patchUpdated') {
      const p = params as FileChangePatchUpdatedNotification;
      this.patchPaths.set(p.itemId, p.changes.map((c) => c.path));
    }
    const event = mapNotification(method, params);
    if (!event) return;
    if (event.kind === 'commandOutput') {
      const delta = this.output.delta(event.itemId, event.delta);
      if (delta === null) return;
      event.delta = delta;
    } else if (event.kind === 'item' && event.item.type === 'commandExecution' && event.item.aggregatedOutput) {
      event.item = { ...event.item, aggregatedOutput: this.output.whole(event.item.id, event.item.aggregatedOutput) };
    }
    this.emit(event);
    if (event.kind === 'turnCompleted') this.cleanBackgroundTerminals();
  }

  /**
   * Codex leaves long commands running in the background after it stops waiting for them (a recursive
   * findstr kept streaming output long after its turn ended). Nothing in mooch reads them later,
   * so a turn's leftover processes end with the turn.
   */
  private cleanBackgroundTerminals(): void {
    if (!this.threadId) return;
    this.rpc('thread/backgroundTerminals/clean', { threadId: this.threadId }).catch(() => {
      // older Codex builds or nothing to clean
    });
  }

  private async handleToolCall(request: IncomingRequest): Promise<void> {
    const call = request.params as DynamicToolCallParams;
    const approve = async (question: ApprovalQuestion, display: { itemId: string; change: FileUpdateChange }): Promise<boolean> => {
      const decision = this.policy?.(question) ?? (this.unattended ? 'decline' : undefined);
      if (decision) return decision === 'accept' || decision === 'acceptForSession';
      const requestId = `fc-edit-${display.itemId}`;
      const answer = new Promise<ApprovalDecision>((resolve) => this.clientApprovals.set(requestId, resolve));
      this.emit({ kind: 'approval', request: { requestId, type: 'fileChange', itemId: display.itemId } });
      const decided = await answer;
      return decided === 'accept' || decided === 'acceptForSession';
    };
    try {
      const response = this.toolHandler
        ? await this.toolHandler(call, approve)
        : { contentItems: [{ type: 'inputText' as const, text: `Tool ${call.tool} is not available.` }], success: false };
      this.connection?.respond(request.id, response);
    } catch (error) {
      this.connection?.respond(request.id, { contentItems: [{ type: 'inputText', text: (error as Error).message }], success: false });
    }
  }

  private onServerRequest(request: IncomingRequest): void {
    if (request.method === 'item/tool/call') {
      void this.handleToolCall(request);
      return;
    }
    if (request.method === 'mcpServer/elicitation/request') {
      this.onElicitation(request);
      return;
    }
    if (!APPROVAL_METHODS.has(request.method)) {
      // Not supported yet (user-input prompts, MCP elicitations, dynamic tools): fail the request so the turn continues.
      this.connection?.respondError(request.id, { code: -32601, message: `${APP_NAME} does not support ${request.method} yet.` });
      this.emit({ kind: 'warning', message: `Declined unsupported agent request: ${request.method}` });
      return;
    }
    this.openApprovals.add(request.id);
    const question: ApprovalQuestion =
      request.method === 'item/commandExecution/requestApproval'
        ? { type: 'command', command: (request.params as CommandExecutionRequestApprovalParams).command ?? '' }
        : { type: 'fileChange', paths: this.patchPaths.get((request.params as FileChangeRequestApprovalParams).itemId) ?? [] };
    const decision = this.policy?.(question) ?? (this.unattended ? 'decline' : undefined);
    if (decision) {
      this.respondToApproval(request.id, decision);
      return;
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      const p = request.params as CommandExecutionRequestApprovalParams;
      this.emit({
        kind: 'approval',
        request: {
          requestId: request.id,
          type: 'command',
          itemId: p.itemId,
          command: p.command ?? undefined,
          cwd: p.cwd ?? undefined,
          reason: p.reason ?? undefined,
        },
      });
    } else {
      const p = request.params as FileChangeRequestApprovalParams;
      this.emit({
        kind: 'approval',
        request: { requestId: request.id, type: 'fileChange', itemId: p.itemId, reason: p.reason ?? undefined },
      });
    }
  }
}
