import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from './agent';
import type { FccSidecar } from './fcc/sidecar';
import { DEFAULT_SETTINGS, type SettingsStore } from './settings';
import type { PromptLibrary } from './team/prompts';

// A stand-in for the Codex engine: threads start, but resuming a saved chat fails.
const fakes = vi.hoisted(() => {
  class FakeCodex {
    static last?: FakeCodex;
    running = false;
    policy?: (question: unknown) => unknown;
    unattended = false;
    toolHandler?: unknown;
    onAllowTool?: unknown;
    turnOverrides?: Record<string, unknown>;
    currentThreadId?: string;
    constructor(_launch: unknown, readonly cwd: string) {
      FakeCodex.last = this;
    }
    async start() {
      this.running = true;
    }
    stop() {
      this.running = false;
    }
    async disableSkills() {}
    async setSkillRoots() {}
    async configureMcp() {}
    async startThread() {
      this.currentThreadId = 'X-thread-0001';
    }
    async resumeThread(): Promise<string> {
      throw new Error('no rollout for that chat');
    }
  }
  return { FakeCodex };
});
vi.mock('./codex/appServer', async (importOriginal) => ({ ...(await importOriginal<typeof import('./codex/appServer')>()), CodexAppServer: fakes.FakeCodex }));

let agent: AgentController | undefined;
afterEach(() => agent?.dispose());

function controller() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mooch-agent-'));
  const project = path.join(dir, 'project');
  mkdirSync(project);
  const catalog = path.join(dir, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ models: [] }));
  const fcc = { url: 'http://127.0.0.1:9', token: 't', modelCatalogPath: catalog, getStatus: () => ({ state: 'running' }), modelList: async () => ({ models: [] }) };
  agent = new AgentController({
    fcc: fcc as unknown as FccSidecar,
    codexBinary: 'codex',
    codexHome: dir,
    raceRoot: path.join(dir, 'races'),
    checkpointRoot: path.join(dir, 'checkpoints'),
    prompts: { render: () => '' } as unknown as PromptLibrary,
    settings: { get: () => ({ ...DEFAULT_SETTINGS, hedge: false }) } as unknown as SettingsStore,
    emit: () => undefined,
  });
  agent.setWorkspace(project);
  return { agent, project };
}

describe('AgentController', () => {
  it('a saved Full-auto chat that fails to open leaves the open chat in charge', async () => {
    const { agent, project } = controller();
    await agent.newThread({ model: 'm', mode: 'ask' });
    await expect(agent.resumeThread('Y-session-0001', { model: 'm', mode: 'full-auto' }, [])).rejects.toThrow(/no rollout/);
    expect(agent.mode).toBe('ask');
    const codex = fakes.FakeCodex.last!;
    // Ask first still asks: nothing became automatic.
    expect(codex.policy!({ type: 'command', command: 'rm file.txt' })).toBeUndefined();
    expect(codex.policy!({ type: 'fileChange', paths: [path.join(project, 'a.txt')] })).toBeUndefined();
    // A later model change keeps the open chat's permissions.
    await agent.updateChat({ model: 'm2' });
    expect(codex.turnOverrides).toMatchObject({ approvalPolicy: 'untrusted' });
  });

  it('races outside Full auto need the user to agree first', async () => {
    const { agent } = controller();
    await agent.newThread({ model: 'm', mode: 'auto-edit' });
    await expect(agent.send('fix it', { race: true })).rejects.toThrow(/Confirm the race/);
    expect(await agent.racePlan()).toMatchObject({ needsConsent: true });
    await agent.updateChat({ mode: 'full-auto' });
    expect(await agent.racePlan()).toMatchObject({ needsConsent: false });
  });
});
