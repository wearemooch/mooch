// Race: several agents solve the same request in separate copies; the project's tests pick the winner.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent, ApprovalMode, ContestantState, FileUpdateChange, RaceState } from '../../shared/ipc';
import { CodexAppServer } from '../codex/appServer';
import { buildCodexLaunch } from '../codex/launch';
import { workspacePolicy } from '../codex/policy';
import { createEditToolHandler } from '../codex/editToolHandler';
import { EDIT_TOOL_SPECS } from '../codex/editTools';
import { linesChanged } from '../team/review';
import { applyChanges, copyWorkspace, detectTestCommand, diffAgainst, removeCopy, runTests, snapshot, type Snapshot } from './workspaceCopy';

export interface RaceDeps {
  codexBinary: string;
  codexHome: string;
  raceRoot: string;
  fcc(): { url: string; token: string; modelCatalogPath: string };
  masterPrompt(workspace: string, model: string): string;
  useEditTools(model: string): boolean;
  modelCatalog(): Promise<string>;
  /** Called right before a race result is written into the workspace. */
  beforeApply?(raceId: string): Promise<void>;
  emit(event: AgentEvent): void;
  contestantTimeoutMs?: number;
}

interface Contestant {
  state: ContestantState;
  dir: string;
  links: string[];
  codex?: CodexAppServer;
  diffs: Map<string, FileUpdateChange>;
}

interface Race {
  state: RaceState;
  workspace: string;
  baseline: Snapshot;
  contestants: Contestant[];
}

/**
 * Contestants edit and run commands in their copies without asking anyone, and mooch runs the test
 * command in each copy. That is Full auto's authority, so in any other mode the user agrees first.
 */
export function raceNeedsConsent(mode: ApprovalMode): boolean {
  return mode !== 'full-auto';
}

export const RACE_CONSENT_REQUIRED = 'A race runs commands and the test command without asking. Confirm the race first, or switch the chat to Full auto.';

/** Winner: tests pass, then the smallest change, then the fastest. Without a test command, the smallest finished change. */
export function pickWinner(contestants: ContestantState[]): string | undefined {
  const finished = contestants.filter((c) => c.status === 'done' && c.changedFiles.length > 0);
  const passing = finished.filter((c) => c.test?.passed);
  const pool = passing.length ? passing : finished.every((c) => !c.test) ? finished : [];
  return [...pool].sort((a, b) => a.linesChanged - b.linesChanged || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))[0]?.id;
}

function developerInstructions(testCommand: string | undefined): string {
  return [
    'You are one of several agents solving the same request at the same time, each in its own copy of the project.',
    'Nobody can answer questions or approve anything while you work, so work autonomously and finish the whole task.',
    'node_modules and Python virtual environments are shared with the real project: do not install, remove or edit dependencies.',
    testCommand
      ? `When you are done, run \`${testCommand}\` and make sure it passes. The copy whose tests pass with the smallest change wins.`
      : 'There is no test command, so verify your change another way. The smallest correct change wins.',
  ].join('\n');
}

export class RaceRunner {
  private races = new Map<string, Race>();

  constructor(private readonly deps: RaceDeps) {}

  async start(workspace: string, request: string, models: string[], testCommand?: string): Promise<void> {
    const id = randomUUID().slice(0, 8);
    const race: Race = {
      workspace,
      baseline: new Map(),
      contestants: [],
      state: { id, phase: 'preparing', contestants: models.map((model, i) => ({ id: `${id}-${i + 1}`, model, status: 'starting', changedFiles: [], linesChanged: 0 })) },
    };
    this.races.set(id, race);
    this.publish(race);
    try {
      race.state.testCommand = testCommand ?? (await detectTestCommand(workspace));
      race.baseline = await snapshot(workspace);
      for (const state of race.state.contestants) {
        const dir = path.join(this.deps.raceRoot, id, state.id);
        const { links } = await copyWorkspace(workspace, dir);
        race.contestants.push({ state, dir, links, diffs: new Map() });
      }
    } catch (error) {
      race.state.phase = 'failed';
      race.state.error = (error as Error).message;
      this.publish(race);
      await this.cleanup(race);
      return;
    }

    race.state.phase = 'running';
    this.publish(race);
    await Promise.all(race.contestants.map((c) => this.runContestant(race, c, request)));

    race.state.phase = 'decided';
    race.state.winnerId = pickWinner(race.state.contestants);
    this.publish(race);
  }

  async apply(raceId: string, contestantId: string): Promise<void> {
    const race = this.races.get(raceId);
    const contestant = race?.contestants.find((c) => c.state.id === contestantId);
    if (!race || !contestant) throw new Error('That race is no longer available.');
    const changes = await diffAgainst(contestant.dir, race.baseline);
    await this.deps.beforeApply?.(raceId);
    race.state.applied = await applyChanges(contestant.dir, race.workspace, race.baseline, changes);
    race.state.phase = 'applied';
    race.state.winnerId = contestantId;
    this.publish(race);
    await this.cleanup(race);
  }

  async discard(raceId: string): Promise<void> {
    const race = this.races.get(raceId);
    if (!race) return;
    race.state.phase = 'discarded';
    this.publish(race);
    await this.cleanup(race);
  }

  dispose(): void {
    for (const race of this.races.values()) for (const c of race.contestants) c.codex?.stop();
  }

  private async runContestant(race: Race, contestant: Contestant, request: string): Promise<void> {
    const { state } = contestant;
    const fcc = this.deps.fcc();
    const modelCatalogPath = await this.deps.modelCatalog();
    let resolveTurn!: (status: string, error?: string) => void;
    const turnDone = new Promise<{ status: string; error?: string }>((resolve) => (resolveTurn = (status, error) => resolve({ status, error })));

    const codex = new CodexAppServer(
      // Contestants go straight to FCC: hedging every contestant would double the load on rate-limited providers.
      buildCodexLaunch({
        codexBinary: this.deps.codexBinary,
        fccUrl: fcc.url,
        fccToken: fcc.token,
        modelCatalogPath,
        codexHome: this.deps.codexHome,
        baseEnv: process.env,
      }),
      contestant.dir,
      (event) => {
        if (event.kind === 'agentDelta') state.lastMessage = ((state.lastMessage ?? '') + event.delta).slice(-400);
        else if (event.kind === 'item' && event.item.type === 'agentMessage' && event.phase === 'completed') state.lastMessage = event.item.text.slice(-400);
        else if (event.kind === 'item' && event.item.type === 'fileChange') for (const change of event.item.changes) contestant.diffs.set(change.path, change);
        else if (event.kind === 'turnCompleted') resolveTurn(event.status, event.error);
        else if (event.kind === 'codex' && event.state === 'stopped') resolveTurn('failed', event.message);
        else return;
        state.linesChanged = [...contestant.diffs.values()].reduce((sum, change) => sum + linesChanged(change.diff), 0);
        this.publish(race);
      },
    );
    // Unattended: edits and commands inside the copy are approved, anything pointing outside is declined.
    codex.policy = workspacePolicy(contestant.dir, 'race');
    codex.unattended = true;
    codex.toolHandler = createEditToolHandler(contestant.dir, () => undefined);
    contestant.codex = codex;
    const timeout = setTimeout(() => resolveTurn('failed', 'Took too long and was stopped.'), this.deps.contestantTimeoutMs ?? 15 * 60_000);
    try {
      await codex.start();
      await codex.startThread(
        state.model,
        { approvalPolicy: 'untrusted', sandbox: 'read-only' },
        { base: this.deps.masterPrompt(contestant.dir, state.model), developer: developerInstructions(race.state.testCommand) },
        { dynamicTools: this.deps.useEditTools(state.model) ? EDIT_TOOL_SPECS : undefined },
      );
      state.status = 'working';
      this.publish(race);
      const startedAt = Date.now();
      await codex.sendMessage(request);
      const result = await turnDone;
      state.durationMs = Date.now() - startedAt;
      if (result.status !== 'completed') throw new Error(result.error ?? `The agent stopped (${result.status}).`);

      const changes = await diffAgainst(contestant.dir, race.baseline);
      state.changedFiles = [...changes.changed, ...changes.added, ...changes.deleted];
      if (race.state.testCommand && state.changedFiles.length) {
        state.status = 'testing';
        this.publish(race);
        state.test = await runTests(race.state.testCommand, contestant.dir);
      }
      state.status = 'done';
    } catch (error) {
      state.status = 'failed';
      state.error = (error as Error).message;
    } finally {
      clearTimeout(timeout);
      codex.stop();
      this.publish(race);
    }
  }

  private async cleanup(race: Race): Promise<void> {
    for (const contestant of race.contestants) {
      contestant.codex?.stop();
      await removeCopy(contestant.dir, contestant.links).catch(() => undefined);
    }
    await removeCopy(path.join(this.deps.raceRoot, race.state.id), []).catch(() => undefined);
  }

  private publish(race: Race): void {
    this.deps.emit({ kind: 'race', race: structuredClone(race.state) });
  }
}
