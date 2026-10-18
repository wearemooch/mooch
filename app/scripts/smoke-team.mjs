// Live end-to-end check of the team features against real models (no Electron).
// Usage: npm run build:main && node scripts/smoke-team.mjs <identity|permissions|shell|review|deep|race|hedge> [model]
// Uses the real mooch gateway config (~/.mooch/gateway, or MOOCH_HOME), so a provider key must be set there.
import fs, { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, '..');
const out = (p) => require(path.join(appRoot, 'out/main', p));
const { FccSidecar } = out('fcc/sidecar.js');
const { AgentController } = out('agent.js');
const { SettingsStore } = out('settings.js');
const { PromptLibrary } = out('team/prompts.js');

const scenario = process.argv[2] ?? 'identity';
const data = path.join(appRoot, '.smoke-data');
const demo = path.join(data, `demo-${scenario}`);
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
writeFileSync(path.join(demo, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
writeFileSync(path.join(demo, 'package.json'), '{ "name": "demo", "type": "module", "scripts": { "test": "node test.js" } }\n');
writeFileSync(
  path.join(demo, 'test.js'),
  "import { add, mul } from './math.js';\nif (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2, 3)); process.exit(1); }\nif (mul(2, 3) !== 6) { console.error('FAIL mul'); process.exit(1); }\nconsole.log('PASS');\n",
);

const settingsFile = path.join(data, `settings-${scenario}.json`);
rmSync(settingsFile, { force: true });
const settings = new SettingsStore(settingsFile);
const fixup = scenario === 'review-fixup';
settings.update({ team: fixup ? { reviewer: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b' } : {}, review: scenario === 'review' || fixup, deep: scenario === 'deep', hedge: scenario === 'hedge', hedgeDelayMs: 8000 });

/** Test-only prompts whose reviewer always asks for one specific change, to exercise the fix-up round. */
function strictPrompts() {
  const dir = path.join(data, 'prompts-fixup');
  rmSync(dir, { recursive: true, force: true });
  cpSync(path.join(appRoot, 'prompts'), dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'reviewer.md'),
    [
      'Ignore the changes below and answer exactly:',
      '',
      'VERDICT: CHANGES',
      '- `math.js:1`: add a one-line `/** Adds two numbers. */` comment directly above `export function add`.',
      '',
      '{{request}}{{summary}}{{diffs}}',
    ].join('\n'),
  );
  return dir;
}

/** A test skill with an unmistakable effect. */
function fixtureSkills() {
  const dir = path.join(data, 'skills');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'release-notes'), { recursive: true });
  writeFileSync(
    path.join(dir, 'release-notes', 'SKILL.md'),
    [
      '---',
      'name: release-notes',
      'description: Write release notes for this project. Use whenever the user asks for release notes or a changelog entry.',
      '---',
      '',
      '# Release notes',
      '',
      'Always start release notes with the exact line "NOTES-BY-SKILL v1", then one bullet per change. Do not run commands.',
      '',
    ].join('\n'),
  );
  return dir;
}

/** Test-only prompts whose compaction summary starts with a marker, to prove the engine used mooch's prompt. */
function markedCompactPrompts() {
  const dir = path.join(data, 'prompts-compact');
  rmSync(dir, { recursive: true, force: true });
  cpSync(path.join(appRoot, 'prompts'), dir, { recursive: true });
  writeFileSync(path.join(dir, 'compact.md'), 'Start your summary with the exact word ZEBRA-SUMMARY on its own line.\n\n' + readFileSync(path.join(appRoot, 'prompts', 'compact.md'), 'utf8'));
  return dir;
}

/** The agent engine for this OS and CPU, from node_modules. */
function engineBinary() {
  const { engineTarget, exe } = require(path.join(appRoot, 'out/main/platform.js'));
  const { pkg, triple } = engineTarget();
  return path.join(appRoot, 'node_modules', ...pkg.split('/'), 'vendor', triple, 'bin', exe('codex'));
}

const fcc = new FccSidecar({ projectDir: path.resolve(appRoot, '..', '_reference', 'free-claude-code'), homeDir: out('paths.js').moochPaths().gateway });
const t0 = Date.now();
const log = (...args) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`, ...args);
if (process.env.SMOKE_VERBOSE) fcc.on('log', (line) => { if (!/admin\/api\/status|GET \/health/.test(line)) log('[gateway]', line.slice(0, 220)); });
let approvals = 0;
let finish;
const finished = new Promise((resolve) => (finish = resolve));
let turns = 0;
const summary = { scenario, events: {} };

const agent = new AgentController({
  fcc,
  codexBinary: engineBinary(),
  codexHome: path.join(data, 'codex-home'),
  checkpointRoot: path.join(data, 'checkpoints'),
  skillsDir: scenario === 'skill' ? fixtureSkills() : undefined,
  mcpServers: scenario.startsWith('mcp') ? () => out('mcp.js').toEngineServers([{ name: 'fixture', command: process.execPath, args: [path.join(appRoot, 'scripts', 'fixtures', 'mcp-fixture.mjs')], env: { FIXTURE_LOG: path.join(data, 'mcp-notes.txt') } }]) : undefined,
  raceRoot: path.join(data, 'races'),
  prompts: new PromptLibrary(fixup ? strictPrompts() : scenario === 'compact' ? markedCompactPrompts() : path.join(appRoot, 'prompts')),
  settings,
  emit: (event) => {
    summary.events[event.kind] = (summary.events[event.kind] ?? 0) + 1;
    if (process.env.SMOKE_VERBOSE && !/Delta|commandOutput/.test(event.kind)) log('event', event.kind, JSON.stringify(event).slice(0, 160));
    switch (event.kind) {
      case 'approval':
        approvals++;
        log('approval', event.request.type, event.request.command ?? '');
        agent.respond(event.request.requestId, 'accept');
        break;
      case 'item':
        if (event.phase === 'completed' && event.item.type === 'agentMessage') log('agent:', event.item.text.replace(/\s+/g, ' ').slice(0, 300));
        if (event.phase === 'completed' && event.item.type === 'commandExecution') log('cmd:', event.item.command.slice(-60), '→', event.item.exitCode);
        if (event.item.type === 'mcpToolCall') log('mcp:', event.phase, event.item.server, event.item.tool, event.item.status, JSON.stringify(event.item.result ?? event.item.error ?? '').slice(0, 120));
        if (event.phase === 'completed' && event.item.type === 'fileChange') log('patch:', event.item.changes.map((c) => c.path).join(', '), event.item.status);
        break;
      case 'status':
      case 'warning':
        log(event.kind, event.message);
        break;
      case 'error':
        log('error', event.willRetry ? '(retrying)' : '', event.message.slice(0, 200));
        break;
      case 'council':
        log('council', event.council.phase, event.council.planners.map((p) => `${p.model.split('/').pop()}:${p.status}`).join(' '));
        if (event.council.phase === 'done') log('merged plan:\n' + event.council.merged);
        break;
      case 'review':
        log('review', event.review.phase, event.review.model, (event.review.text ?? '').replace(/\s+/g, ' ').slice(0, 300));
        break;
      case 'race':
        log('race', event.race.phase, event.race.contestants.map((c) => `${c.model.split('/').pop()}:${c.status}${c.test ? (c.test.passed ? '/pass' : '/fail') : ''}/${c.linesChanged}l`).join(' '), event.race.winnerId ?? '');
        if (event.race.phase === 'decided') {
          if (event.race.winnerId) void agent.applyRace(event.race.id, event.race.winnerId);
          else finish();
        }
        if (['applied', 'failed', 'discarded'].includes(event.race.phase)) finish();
        break;
      case 'turnCompleted':
        turns++;
        log('turn completed', event.status, event.error ?? '');
        // In review mode a "changes" verdict starts one more turn; give it a moment to begin.
        finish();
        break;
    }
  },
});

if (process.env.SMOKE_GIVE_UP_MS) {
  // Exercise the "no model answered" path: no stand-ins, and a short deadline.
  Object.assign(agent['hedge']['config'], { backupsFor: () => [], giveUpMs: Number(process.env.SMOKE_GIVE_UP_MS) });
}

const reviewDone =scenario === 'review' || fixup ? new Promise((resolve) => {
  const original = agent['options'].emit;
  agent['options'].emit = (event) => {
    original(event);
    if (event.kind === 'review' && event.review.phase !== 'reviewing') resolve(event.review.phase);
  };
}) : undefined;

if (fixup) {
  // Inject a "changes requested" verdict so the fix-up round runs; the agent's side stays live.
  const realAsk = agent.ask.bind(agent);
  agent.ask = (model, instructions, ...rest) =>
    instructions.startsWith('Ignore the changes below')
      ? Promise.resolve('VERDICT: CHANGES\n- `math.js:1`: add a one-line `/** Adds two numbers. */` comment directly above `export function add`.')
      : realAsk(model, instructions, ...rest);
}

try {
  await fcc.start();
  const model = process.argv[3] ?? (await fcc.modelList()).defaultModel;
  agent.setWorkspace(demo);
  const team = await agent.resolveTeam(model);
  log('team', JSON.stringify(team));
  if (scenario.startsWith('mcp')) rmSync(path.join(data, 'mcp-notes.txt'), { force: true });
  await agent.newThread({ model, mode: scenario === 'mcp-full' ? 'full-auto' : 'ask' });
  const prompt =
    ['identity', 'hedge'].includes(scenario)
      ? 'Without running any commands: what is your name, and which shell do you use here? One sentence.'
      : scenario === 'permissions'
        ? 'Without running any commands: can you edit files in this project, or is it read-only for you? One sentence.'
        : scenario.startsWith('mcp')
          ? 'Use the fixture tools: get the codeword, then save a note with the text "hello from penny". Finally tell me the codeword.'
        : scenario === 'skill'
          ? 'Write release notes for the fix where add() now adds instead of subtracting.'
        : scenario === 'compact'
          ? 'Remember: the project codename is HERON. Reply only with "ok".'
        : scenario === 'resume'
          ? 'Remember this code word for later: MANGO-42. Reply only with "noted".'
        : scenario === 'shell'
          ? 'Run exactly this command and reply with its raw output only: (Get-Command rg -ErrorAction SilentlyContinue).Source; $PSVersionTable.PSVersion.ToString()'
        : 'npm test fails. Find and fix the bug, then run npm test to confirm it passes.';
  await agent.send(prompt, { race: scenario === 'race', openFiles: [path.join(demo, 'math.js')] });
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('scenario timeout')), 540_000))]);
  if (scenario.startsWith('mcp')) {
    log('mcp status', JSON.stringify((await agent.mcpStatus())?.map((s) => ({ name: s.name, status: s.runtimeStatus, tools: Object.keys(s.tools), error: s.toolsError }))));
    let notes = '';
    try {
      notes = readFileSync(path.join(data, 'mcp-notes.txt'), 'utf8').trim();
    } catch {}
    log('note saved by the server:', JSON.stringify(notes), 'approvals asked:', approvals);
  }
  if (scenario === 'skill') {
    let answer = '';
    const original = agent['options'].emit;
    const turned = new Promise((resolve) => {
      agent['options'].emit = (event) => {
        original(event);
        if (event.kind === 'item' && event.phase === 'completed' && event.item.type === 'agentMessage') answer = event.item.text;
        if (event.kind === 'turnCompleted') resolve();
      };
    });
    await agent.newThread({ model, mode: 'ask' });
    await agent.send('Summarize the mul() change for the changelog.', { skill: { name: 'release-notes', path: path.join(data, 'skills', 'release-notes', 'SKILL.md') } });
    await Promise.race([turned, new Promise((r) => setTimeout(r, 180_000))]);
    log('explicit skill:', answer.replace(/s+/g, ' ').slice(0, 120));
  }
  if (scenario === 'compact') {
    let answer = '';
    const original = agent['options'].emit;
    let compacted;
    const done = new Promise((resolve) => (compacted = resolve));
    agent['options'].emit = (event) => {
      original(event);
      if (event.kind === 'item' && event.item.type === 'contextCompaction' && event.phase === 'completed') compacted();
      if (event.kind === 'item' && event.phase === 'completed' && event.item.type === 'agentMessage') answer = event.item.text;
      if (event.kind === 'tokenUsage') log('context', event.usage.last.inputTokens);
    };
    await agent.compact();
    await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))]);
    log('compacted');
    const turned = new Promise((resolve) => {
      const before = agent['options'].emit;
      agent['options'].emit = (event) => {
        before(event);
        if (event.kind === 'turnCompleted') resolve();
      };
    });
    await agent.send('What is the project codename? Reply with just the word.');
    await Promise.race([turned, new Promise((r) => setTimeout(r, 120_000))]);
    log('after compaction:', answer);
    const threadId = agent['codex'].currentThreadId;
    const rollouts = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.includes(threadId) && rollouts.push(path.join(dir, e.name)); };
    walk(path.join(data, 'codex-home', 'sessions'));
    log('summary used mooch prompt:', rollouts.some((file) => readFileSync(file, 'utf8').includes('ZEBRA-SUMMARY')));
  }
  if (scenario === 'resume') {
    // Restart the engine (as after quitting the app), continue the saved chat, and ask about it.
    const threadId = agent['codex'].currentThreadId;
    agent.setWorkspace(path.join(data, 'elsewhere'));
    agent.setWorkspace(demo);
    let answer = '';
    const original = agent['options'].emit;
    const asked = new Promise((resolve) => {
      agent['options'].emit = (event) => {
        original(event);
        if (event.kind === 'item' && event.phase === 'completed' && event.item.type === 'agentMessage') answer = event.item.text;
        if (event.kind === 'turnCompleted') resolve();
      };
    });
    await agent.resumeThread(threadId, { model, mode: 'ask' }, []);
    log('resumed', threadId, 'engine pid changed:', !!agent['codex']);
    await agent.send('What was the code word I gave you? Reply with just the word.');
    await Promise.race([asked, new Promise((r) => setTimeout(r, 180_000))]);
    log('memory after resume:', answer.replace(/s+/g, ' ').slice(0, 120));
  }
  if (scenario === 'restore') {
    // Rewind files + conversation to before the fix, check the agent no longer remembers it, then undo the restore.
    const point = [...agent['points'].values()].find((p) => p.reason === 'message' && p.canRewind);
    log('restore point', point?.id, point?.label);
    log('preview', JSON.stringify(await agent.previewRestore(point.id)));
    const rewound = await agent.restore(point.id, true);
    log('rewound', JSON.stringify(rewound), '→ math.js line 2:', readFileSync(path.join(demo, 'math.js'), 'utf8').split('\n')[1].trim());
    let answer = '';
    const original = agent['options'].emit;
    const asked = new Promise((resolve) => {
      agent['options'].emit = (event) => {
        original(event);
        if (event.kind === 'item' && event.phase === 'completed' && event.item.type === 'agentMessage') answer = event.item.text;
        if (event.kind === 'turnCompleted') resolve();
      };
    });
    await agent.send('Without running anything: did I ask you to change any code earlier in this conversation? Answer YES or NO, then one short sentence.');
    await Promise.race([asked, new Promise((r) => setTimeout(r, 180_000))]);
    log('memory check:', answer.replace(/\s+/g, ' ').slice(0, 200));
    const undone = await agent.restore(rewound.undoPointId, false);
    log('undo restore', JSON.stringify(undone.files), '→ math.js line 2:', readFileSync(path.join(demo, 'math.js'), 'utf8').split('\n')[1].trim());
  }
  if (reviewDone && readFileSync(path.join(demo, 'math.js'), 'utf8').includes('a + b')) {
    const phase = await Promise.race([reviewDone, new Promise((r) => setTimeout(() => r('no review'), 180_000))]);
    log('review finished:', phase);
    if (phase === 'changes') await Promise.race([new Promise((r) => { const t = setInterval(() => { if (turns >= 2) { clearInterval(t); r(); } }, 1000); }), new Promise((r) => setTimeout(r, 300_000))]);
  }
} catch (error) {
  log('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  agent.dispose();
  await fcc.stop();
  summary.approvals = approvals;
  summary.mathJs = readFileSync(path.join(demo, 'math.js'), 'utf8').split('\n')[1]?.trim();
  summary.seconds = Math.round((Date.now() - t0) / 1000);
  console.log('SUMMARY', JSON.stringify(summary));
  // The scenario timeout above would otherwise keep Node alive for minutes.
  process.exit(process.exitCode ?? 0);
}
