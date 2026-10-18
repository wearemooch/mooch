// Backend smoke test without Electron: gateway -> agent engine -> thread -> one real turn that must
// create a file. Used by CI on every OS. Needs a provider key in .smoke-data/fcc-home/.fcc/.env.
// Usage: npm run build:main && node scripts/smoke-backend.mjs [workspaceDir] [prompt]
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, '..');
const out = (p) => require(path.join(appRoot, 'out/main', p));
const { FccSidecar } = out('fcc/sidecar.js');
const { AgentController } = out('agent.js');
const { SettingsStore } = out('settings.js');
const { PromptLibrary } = out('team/prompts.js');
const { engineTarget, exe } = out('platform.js');

const dataDir = path.join(appRoot, '.smoke-data');
const workspace = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'mooch-smoke-'));
const prompt = process.argv[3] ?? 'Create a file hello.txt containing the word hi. Reply "done" when finished.';
mkdirSync(path.join(dataDir, 'codex-home'), { recursive: true });

/** The agent engine for this OS and CPU, from node_modules. */
function engineBinary() {
  const { pkg, triple } = engineTarget();
  return path.join(appRoot, 'node_modules', ...pkg.split('/'), 'vendor', triple, 'bin', exe('codex'));
}

const fcc = new FccSidecar({
  projectDir: path.resolve(appRoot, '..', '_reference', 'free-claude-code'),
  homeDir: path.join(dataDir, 'fcc-home'),
});
fcc.on('status', (s) => console.log('[fcc status]', JSON.stringify(s)));

let finish;
const done = new Promise((resolve) => (finish = resolve));
const agent = new AgentController({
  fcc,
  codexBinary: engineBinary(),
  codexHome: path.join(dataDir, 'codex-home'),
  checkpointRoot: path.join(dataDir, 'checkpoints'),
  raceRoot: path.join(dataDir, 'races'),
  prompts: new PromptLibrary(path.join(appRoot, 'prompts')),
  settings: new SettingsStore(path.join(dataDir, 'settings-backend.json')),
  emit: (event) => {
    if (event.kind === 'agentDelta' || event.kind === 'commandOutput' || event.kind === 'reasoningDelta') {
      process.stdout.write(event.delta);
      return;
    }
    console.log('\n[event]', JSON.stringify(event).slice(0, 400));
    if (event.kind === 'approval') agent.respond(event.request.requestId, 'accept');
    if (event.kind === 'turnCompleted') finish();
  },
});

try {
  await fcc.start();
  const models = await fcc.models();
  console.log('[models]', models.map((m) => m.slug).join(', ') || '(none)');
  if (!models.length) throw new Error('The gateway published no models (is a provider key set?)');
  // A model that answered reliably in our probes, when present; the hedge proxy covers busy ones.
  const model = process.env.SMOKE_MODEL ?? models.find((m) => /nemotron-3-super/.test(m.slug))?.slug ?? models[0].slug;
  agent.setWorkspace(workspace);
  await agent.newThread({ model, mode: 'auto-edit' });
  console.log('[workspace]', workspace, '[model]', model);
  await agent.send(prompt);
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('turn timeout')), 240_000))]);
  if (!process.argv[3]) {
    const file = path.join(workspace, 'hello.txt');
    if (!existsSync(file) || !/hi/i.test(readFileSync(file, 'utf8'))) throw new Error('hello.txt was not created');
    console.log('\n[smoke ok] hello.txt created');
  }
} catch (error) {
  console.error('[smoke failed]', error.message);
  process.exitCode = 1;
} finally {
  agent.dispose();
  await fcc.stop();
  process.exit(process.exitCode ?? 0);
}
