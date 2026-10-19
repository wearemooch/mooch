// Ties the pieces together: the main Codex agent (through the hedge proxy to FCC), the plan council
// before a message, the second-model review after it, and races.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, ApprovalDecision, ApprovalMode, ModelOption, FileUpdateChange, NewThreadOptions, RacePlan, ResolvedTeam, RestoreFile, RestorePoint, RestoreResult, SendOptions } from '../shared/ipc';
import { ShadowGit } from './checkpoints/shadowGit';
import { approvalSettings, CodexAppServer, turnPermissions } from './codex/appServer';
import type { McpServerStatus } from './codex/protocol/v2/McpServerStatus';
import { workspacePolicy, type ApprovalPolicy } from './codex/policy';
import { createEditToolHandler, usesEditTools, writeDerivedCatalog } from './codex/editToolHandler';
import { EDIT_TOOL_SPECS } from './codex/editTools';
import { buildCodexLaunch } from './codex/launch';
import type { FccSidecar } from './fcc/sidecar';
import { HedgeProxy } from './llm/hedge';
import { ModelHealth } from './llm/modelHealth';
import { oneShot } from './llm/oneShot';
import { RACE_CONSENT_REQUIRED, RaceRunner, raceNeedsConsent } from './race/race';
import { detectTestCommand } from './race/workspaceCopy';
import type { SettingsStore } from './settings';
import { buildContext } from './team/context';
import { runCouncil, withPlan } from './team/council';
import { environmentValues, type PermissionContext, type PromptLibrary } from './team/prompts';
import { feedbackMessage, formatDiffs, parseVerdict } from './team/review';
import { pickModels, resolveTeam } from './team/team';
import { captureSnapshot, changesSince, type TurnSnapshot } from './team/turnSnapshot';

export interface AgentControllerOptions {
  fcc: FccSidecar;
  codexBinary: string;
  codexHome: string;
  raceRoot: string;
  /** Where the shadow git repositories for restore points live. */
  checkpointRoot: string;
  /** ~/.mooch/skills. */
  skillsDir?: string;
  /** The engine's [mcp_servers], from ~/.mooch/mcp.json. */
  mcpServers?: () => Record<string, unknown>;
  /** The user picked "Always" for an integration's tool. */
  onAllowTool?: (server: string, tool: string) => void;
  prompts: PromptLibrary;
  settings: SettingsStore;
  emit: (event: AgentEvent) => void;
}

/** What the current user message has done so far, for the review step. */
interface TurnContext {
  request: string;
  /** Changes reported by apply_patch. */
  changes: FileUpdateChange[];
  /** The workspace before the turn; diffing against it also catches files written by shell commands. */
  before?: TurnSnapshot;
  summary: string;
  reviewed: boolean;
}

export class AgentController {
  private codex?: CodexAppServer;
  private cwd?: string;
  private threadOptions?: NewThreadOptions;
  private turn?: TurnContext;
  private readonly hedge: HedgeProxy;
  private readonly race: RaceRunner;
  private team?: ResolvedTeam;
  private models: ModelOption[] = [];
  readonly health: ModelHealth;
  /** The edit-tool setting the running Codex process was launched with (its catalog depends on it). */
  private codexLaunchKey?: string;
  private checkpoints?: ShadowGit;
  /** Restore point id → the first turn of the message it was taken before, for Rewind. */
  private readonly pointTurns = new Map<string, string>();
  private readonly points = new Map<string, RestorePoint>();

  constructor(private readonly options: AgentControllerOptions) {
    const { fcc, settings } = options;
    this.health = new ModelHealth((busyUntil) => options.emit({ kind: 'modelHealth', busyUntil }));
    this.hedge = new HedgeProxy({
      upstream: () => (fcc.url && fcc.getStatus().state === 'running' ? { url: fcc.url, token: fcc.token } : undefined),
      // The team's backup first, then the next-best models, so a busy backup has stand-ins too.
      backupsFor: (model) => [...(this.team?.executor === model && this.team.backup ? [this.team.backup] : []), ...pickModels(this.models, 4, [model])],
      health: this.health,
      enabled: () => settings.get().hedge,
      delayMs: () => settings.get().hedgeDelayMs,
      onStatus: (message, note) => options.emit({ kind: 'status', message, note }),
    });
    this.race = new RaceRunner({
      codexBinary: options.codexBinary,
      codexHome: options.codexHome,
      raceRoot: options.raceRoot,
      fcc: () => ({ url: fcc.url!, token: fcc.token, modelCatalogPath: fcc.modelCatalogPath }),
      masterPrompt: (workspace, model) => this.masterPrompt(workspace, model, 'race'),
      useEditTools: (model) => this.useEditTools(model),
      modelCatalog: () => this.derivedCatalog(),
      beforeApply: async () => void (await this.createPoint('Before applying the race result', 'race')),
      emit: options.emit,
    });
  }

  /** The permission mode of the open chat. */
  get mode(): ApprovalMode {
    return this.threadOptions?.mode ?? 'ask';
  }

  /** Called when a folder is opened; the next thread runs there. */
  setWorkspace(cwd: string): void {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    this.codex?.stop();
    this.codex = undefined;
    this.turn = undefined;
    this.checkpoints = new ShadowGit(cwd, this.options.checkpointRoot);
    this.pointTurns.clear();
    this.points.clear();
  }

  async resolveTeam(executor: string): Promise<ResolvedTeam> {
    const { models } = await this.options.fcc.modelList();
    this.models = models;
    this.team = resolveTeam(models, executor, this.options.settings.get().team);
    return this.team;
  }

  async newThread(threadOptions: NewThreadOptions): Promise<void> {
    if (this.codex && this.codexLaunchKey !== this.launchKey()) {
      // The model catalog Codex was started with no longer matches the setting.
      this.codex.stop();
      this.codex = undefined;
    }
    const codex = await this.ensureCodex();
    this.threadOptions = threadOptions;
    this.turn = undefined;
    await this.resolveTeam(threadOptions.model);
    codex.policy = this.policyFor(threadOptions.mode);
    await codex.startThread(
      threadOptions.model,
      approvalSettings(threadOptions.mode),
      { base: this.masterPrompt(this.cwd!, threadOptions.model, threadOptions.mode) },
      { dynamicTools: this.useEditTools(threadOptions.model) ? EDIT_TOOL_SPECS : undefined },
    );
  }

  /**
   * Continues a saved chat: the engine reloads its history, and the restore points recorded in the
   * chat's log come back, so Restore and Rewind keep working on old messages.
   */
  async resumeThread(threadId: string, threadOptions: NewThreadOptions, log: AgentEvent[]): Promise<void> {
    if (this.codex && this.codexLaunchKey !== this.launchKey()) {
      this.codex.stop();
      this.codex = undefined;
    }
    const codex = await this.ensureCodex();
    const previous = { team: this.team, models: this.models };
    try {
      await this.resolveTeam(threadOptions.model);
      await codex.resumeThread(threadId, threadOptions.model, approvalSettings(threadOptions.mode), {
        base: this.masterPrompt(this.cwd!, threadOptions.model, threadOptions.mode),
      });
    } catch (error) {
      this.team = previous.team;
      this.models = previous.models;
      throw error;
    }
    // Only now does the saved chat's mode apply. Until the engine has it open, the chat in the window
    // (and its approval policy) stays in charge; a saved Full-auto chat that fails to open changes nothing.
    this.threadOptions = threadOptions;
    this.turn = undefined;
    codex.policy = this.policyFor(threadOptions.mode);
    this.points.clear();
    this.pointTurns.clear();
    for (const event of log) {
      if (event.kind !== 'restorePoint') continue;
      this.points.set(event.point.id, event.point);
      if (event.point.turnId) this.pointTurns.set(event.point.id, event.point.turnId);
    }
  }

  /** What a race would run here, so the user can agree to it before it starts. */
  async racePlan(): Promise<RacePlan> {
    if (!this.cwd) throw new Error('Open a folder first.');
    const testCommand = this.options.settings.get().raceTestCommand ?? (await detectTestCommand(this.cwd));
    return { testCommand, needsConsent: raceNeedsConsent(this.mode) };
  }

  /** Changes the open chat's model or permissions from the next message on. */
  async updateChat(update: Partial<NewThreadOptions>): Promise<void> {
    if (!this.threadOptions || !this.codex?.currentThreadId) return;
    this.threadOptions = { ...this.threadOptions, ...update };
    const { model, mode } = this.threadOptions;
    if (update.model) await this.resolveTeam(model);
    this.codex.policy = this.policyFor(mode);
    this.codex.turnOverrides = { model, ...turnPermissions(mode) };
  }

  async compact(): Promise<void> {
    if (!this.codex?.currentThreadId) throw new Error('No chat to compact yet.');
    await this.codex.compact();
  }

  /** Reviews the project's uncommitted changes (needs a git repository). */
  async reviewChanges(): Promise<void> {
    if (!this.cwd || !existsSync(path.join(this.cwd, '.git'))) throw new Error('/review looks at uncommitted git changes, and this folder is not a git repository.');
    const codex = await this.ensureCodex();
    if (!codex.currentThreadId) {
      if (!this.threadOptions) throw new Error('Pick a model first.');
      await this.newThread(this.threadOptions);
    }
    await codex.reviewUncommitted();
  }

  /** Deletes a saved chat from the engine (best effort; mooch's own log is removed by the caller). */
  async deleteThread(threadId: string): Promise<void> {
    if (this.codex?.currentThreadId === threadId) throw new Error('This chat is open. Start a new chat first.');
    const codex = await this.ensureCodex();
    await codex.deleteThread(threadId);
  }

  async send(text: string, sendOptions: SendOptions = {}): Promise<void> {
    if (!this.threadOptions) throw new Error('Pick a model to start a thread.');
    const team = await this.resolveTeam(this.threadOptions.model);

    if (sendOptions.race) {
      if (!this.cwd) throw new Error('Open a folder first.');
      if (raceNeedsConsent(this.mode) && !sendOptions.raceConsent) throw new Error(RACE_CONSENT_REQUIRED);
      // Races work in copies; the restore point is taken right before a result is applied.
      // Runs in the background; progress arrives as race events.
      void this.race
        .start(this.cwd, text, team.contestants, this.options.settings.get().raceTestCommand)
        .catch((error: Error) => this.options.emit({ kind: 'error', message: `Race failed: ${error.message}`, willRetry: false }));
      return;
    }

    const point = await this.createPoint(`Before: ${text.replace(/\s+/g, ' ').slice(0, 80)}`, 'message', text);
    let message = text;
    if ((this.options.settings.get().deep || sendOptions.deep) && team.planners.length) {
      const context = await buildContext(this.cwd!, { openFiles: sendOptions.openFiles });
      const plan = await runCouncil({
        request: text,
        planners: team.planners,
        judge: team.judge,
        plannerInstructions: this.options.prompts.render('planner', { context }),
        judgeInstructions: (plans) => this.options.prompts.render('judge', { context, plans }),
        ask: (model, instructions, input, timeoutMs, signal) => this.ask(model, instructions, input, timeoutMs, signal),
        emit: (council) => this.options.emit({ kind: 'council', council }),
      });
      if (plan) message = withPlan(text, plan);
    }

    const codex = await this.ensureCodex();
    if (!codex.currentThreadId) await this.newThread(this.threadOptions);
    this.turn = { request: text, changes: [], summary: '', reviewed: false, before: await captureSnapshot(this.cwd!) };
    const turnId = await codex.sendMessage(message, sendOptions.skill);
    if (point) {
      this.pointTurns.set(point.id, turnId);
      point.canRewind = true;
      point.turnId = turnId;
      this.options.emit({ kind: 'restorePoint', point: { ...point } });
    }
  }

  async interrupt(): Promise<void> {
    await this.codex?.interrupt();
  }

  respond(requestId: string | number, decision: ApprovalDecision, content?: Record<string, unknown>): void {
    this.codex?.respondToApproval(requestId, decision, content);
  }

  /** What restoring a point would change right now. */
  async previewRestore(pointId: string): Promise<RestoreFile[]> {
    if (!this.checkpoints) throw new Error('Open a folder first.');
    return this.checkpoints.preview(pointId);
  }

  /**
   * Puts the files back to a restore point. With `rewind`, the conversation is also cut back to before
   * that message. A new restore point is taken first, so the restore can be undone.
   */
  async restore(pointId: string, rewind: boolean): Promise<RestoreResult> {
    if (!this.checkpoints) throw new Error('Open a folder first.');
    if (this.codex?.turnRunning) throw new Error('Stop the agent before restoring.');
    const target = this.points.get(pointId);
    const undoPoint = await this.createPoint(`Before restoring to: ${target?.label ?? pointId.slice(0, 8)}`, 'restore');
    const files = await this.checkpoints.restore(pointId);
    let rewound = false;
    const turnId = this.pointTurns.get(pointId);
    if (rewind && turnId && this.codex?.running) {
      await this.codex.revertConversation(turnId);
      rewound = true;
      // Points taken after this one belong to turns that no longer exist in the conversation.
      const removedAfter = target?.createdAt ?? 0;
      for (const [id, point] of this.points) if (point.createdAt >= removedAfter && point.reason === 'message') this.pointTurns.delete(id);
    }
    this.turn = undefined;
    const result: RestoreResult = { pointId, files, undoPointId: undoPoint!.id, rewound, message: rewound ? target?.message : undefined };
    this.options.emit({ kind: 'restored', result });
    return result;
  }

  private async createPoint(label: string, reason: RestorePoint['reason'], message?: string): Promise<RestorePoint | undefined> {
    if (!this.checkpoints) return undefined;
    try {
      const checkpoint = await this.checkpoints.create(label);
      const point: RestorePoint = { ...checkpoint, reason, message, canRewind: false };
      this.points.set(point.id, point);
      this.options.emit({ kind: 'restorePoint', point: { ...point } });
      return point;
    } catch (error) {
      // Restore points are a safety net; a failure must not block the agent.
      this.options.emit({ kind: 'warning', message: `Could not save a restore point: ${(error as Error).message}` });
      return undefined;
    }
  }

  applyRace(raceId: string, contestantId: string): Promise<void> {
    return this.race.apply(raceId, contestantId);
  }

  discardRace(raceId: string): Promise<void> {
    return this.race.discard(raceId);
  }

  dispose(): void {
    this.codex?.stop();
    this.race.dispose();
    this.hedge.stop();
  }

  private masterPrompt(workspace: string, model: string, permissions: PermissionContext): string {
    return this.options.prompts.render('master', environmentValues(workspace, model, this.useEditTools(model), permissions));
  }

  /**
   * The engine reads skills from ~/.mooch/skills and the project's .mooch/skills. Its built-ins that need
   * an OpenAI account, or that claim "this app" is Codex, or install skills behind mooch's back, are off.
   */
  private async configureSkills(codex: CodexAppServer): Promise<void> {
    try {
      await codex.disableSkills(['imagegen', 'openai-docs', 'skill-installer', 'skill-creator']);
      const roots = [this.options.skillsDir, this.cwd && path.join(this.cwd, '.mooch', 'skills')].filter((r): r is string => !!r && existsSync(r));
      await codex.setSkillRoots(roots);
    } catch (error) {
      this.options.emit({ kind: 'warning', message: `Skills could not be loaded: ${(error as Error).message}` });
    }
  }

  private async configureMcp(codex: CodexAppServer): Promise<void> {
    if (!this.options.mcpServers) return;
    try {
      await codex.configureMcp(this.options.mcpServers());
    } catch (error) {
      this.options.emit({ kind: 'warning', message: `Integrations could not be loaded: ${(error as Error).message}` });
    }
  }

  /** After mcp.json changed: the running engine reconnects its servers. */
  async reloadMcp(): Promise<void> {
    if (this.codex?.running) await this.configureMcp(this.codex);
  }

  /** The engine's view of the MCP servers, or undefined while it isn't running. */
  async mcpStatus(): Promise<McpServerStatus[] | undefined> {
    if (!this.codex?.running) return undefined;
    return this.codex.mcpStatus();
  }

  async mcpLogin(name: string): Promise<string> {
    const codex = await this.ensureCodex();
    return codex.mcpLogin(name);
  }

  /** After installing or removing a skill: the running engine re-reads the skill folders. */
  async reloadSkills(): Promise<void> {
    if (this.codex?.running) await this.configureSkills(this.codex);
  }

  /** Full auto answers everything mooch is asked (the engine itself asks nothing then, except integrations). */
  private policyFor(mode: ApprovalMode): ApprovalPolicy {
    return mode === 'full-auto' ? () => 'accept' : workspacePolicy(this.cwd!, mode);
  }

  /** Settings the engine is launched with; a new chat restarts it when they changed. */
  private launchKey(): string {
    const { editTool, autoCompactTokens } = this.options.settings.get();
    return `${editTool}|${autoCompactTokens}`;
  }

  private useEditTools(model: string): boolean {
    return usesEditTools(model, this.options.settings.get().editTool);
  }

  private derivedCatalog(): Promise<string> {
    const { fcc } = this.options;
    return writeDerivedCatalog(fcc.modelCatalogPath, path.join(this.options.codexHome, 'model-catalog.json'), (slug) => this.useEditTools(slug));
  }

  private ask(model: string, instructions: string, input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const { fcc } = this.options;
    if (!fcc.url) return Promise.reject(new Error('The model gateway is not running.'));
    return oneShot({ fccUrl: fcc.url, token: fcc.token, model, instructions, input, timeoutMs, signal });
  }

  /** Watches the main agent's events to collect what the review needs. */
  private onEvent(event: AgentEvent): void {
    this.options.emit(event);
    const turn = this.turn;
    if (!turn) return;
    if (event.kind === 'item' && event.phase === 'completed') {
      if (event.item.type === 'fileChange' && event.item.status === 'completed') turn.changes.push(...event.item.changes);
      if (event.item.type === 'agentMessage') turn.summary = event.item.text;
    } else if (event.kind === 'turnCompleted' && event.status === 'completed') {
      void this.finishTurn(turn);
    }
  }

  private async finishTurn(turn: TurnContext): Promise<void> {
    if (turn.before && this.cwd) {
      const all = await changesSince(this.cwd, turn.before);
      // Edits made through shell commands never show up as file-change items; show them too.
      const patched = new Set(turn.changes.map((c) => path.resolve(this.cwd!, c.path).toLowerCase()));
      const unseen = all.filter((c) => !patched.has(path.resolve(this.cwd!, c.path).toLowerCase()));
      if (unseen.length) {
        this.options.emit({ kind: 'item', phase: 'completed', item: { type: 'fileChange', id: `shell-edits-${randomUUID()}`, changes: unseen, status: 'completed' } });
      }
      if (all.length) turn.changes = all;
    }
    await this.review(turn);
  }

  private async review(turn: TurnContext): Promise<void> {
    const reviewer = this.team?.reviewer;
    if (turn.reviewed || !turn.changes.length || !reviewer || !this.options.settings.get().review) return;
    turn.reviewed = true;
    const id = randomUUID();
    this.options.emit({ kind: 'review', review: { id, model: reviewer, phase: 'reviewing' } });
    try {
      const answer = await this.ask(
        reviewer,
        this.options.prompts.render('reviewer', { request: turn.request, summary: turn.summary || '(no summary)', diffs: formatDiffs(turn.changes) }),
        'Review these changes. Your first line must be exactly "VERDICT: APPROVE" or "VERDICT: CHANGES".',
        150_000,
      );
      const verdict = parseVerdict(answer);
      const phase = verdict.verdict === 'changes' ? 'changes' : verdict.verdict === 'approve' ? 'approved' : 'comments';
      this.options.emit({ kind: 'review', review: { id, model: reviewer, phase, text: verdict.body || answer } });
      if (phase === 'changes' && this.turn === turn && this.codex?.running) {
        // One fix-up round: the next turn's changes are not reviewed again.
        this.turn = { request: turn.request, changes: [], summary: '', reviewed: true, before: this.cwd ? await captureSnapshot(this.cwd) : undefined };
        await this.codex.sendMessage(feedbackMessage(reviewer, verdict.body));
      }
    } catch (error) {
      this.options.emit({ kind: 'review', review: { id, model: reviewer, phase: 'failed', text: (error as Error).message } });
    }
  }

  private async ensureCodex(): Promise<CodexAppServer> {
    if (this.codex?.running) return this.codex;
    if (!this.cwd) throw new Error('Open a folder first.');
    const { fcc } = this.options;
    if (fcc.getStatus().state !== 'running' || !fcc.url) throw new Error('The model gateway is still starting. Try again in a moment.');

    const launch = buildCodexLaunch({
      codexBinary: this.options.codexBinary,
      fccUrl: await this.hedge.start(),
      fccToken: fcc.token,
      modelCatalogPath: await this.derivedCatalog(),
      codexHome: this.options.codexHome,
      baseEnv: process.env,
      autoCompactTokens: this.options.settings.get().autoCompactTokens,
      compactPrompt: this.options.prompts.render('compact', {}),
    });
    const codex = new CodexAppServer(launch, this.cwd, (event) => this.onEvent(event));
    codex.toolHandler = createEditToolHandler(this.cwd, (event) => this.onEvent(event));
    codex.onAllowTool = this.options.onAllowTool;
    this.codexLaunchKey = this.launchKey();
    this.codex = codex;
    await codex.start();
    await this.configureSkills(codex);
    await this.configureMcp(codex);
    return codex;
  }
}
