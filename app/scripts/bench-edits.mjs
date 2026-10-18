// Benchmark: Codex's freeform apply_patch vs free-code's edit_file/write_file tools, same model and tasks.
// Usage: npm run build:main && node scripts/bench-edits.mjs [--trials 2] [--formats apply_patch,edit_file] [--tasks fix,add,rename] [--model slug]
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, '..');
const out = (p) => require(path.join(appRoot, 'out/main', p));
const { FccSidecar } = out('fcc/sidecar.js');
const { AgentController } = out('agent.js');
const { SettingsStore } = out('settings.js');
const { PromptLibrary } = out('team/prompts.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const trials = Number(arg('trials', '2'));
const formats = arg('formats', 'apply_patch,edit_file').split(',');
const taskNames = arg('tasks', 'fix,add,rename').split(',');
const data = path.join(appRoot, '.smoke-data', 'bench');
const codexHome = path.join(data, 'codex-home');
mkdirSync(codexHome, { recursive: true });

const BUGGY = 'export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n';
const FIXED = BUGGY.replace('a - b', 'a + b');
const TEST =
  "import { add, mul } from './math.js';\nif (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2, 3)); process.exit(1); }\nif (mul(2, 3) !== 6) { console.error('FAIL mul'); process.exit(1); }\nconsole.log('PASS');\n";
const read = (dir, f) => readFileSync(path.join(dir, f), 'utf8');
const testsPass = (dir) => {
  try {
    execSync('npm test', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const TASKS = {
  fix: {
    math: BUGGY,
    prompt: 'npm test fails. Find and fix the bug, then run npm test to confirm it passes.',
    check: (dir) => testsPass(dir),
  },
  add: {
    math: FIXED,
    prompt: 'Add a function `sub(a, b)` to math.js that returns a minus b, and add a test for it in test.js. Then run npm test.',
    check: (dir) => testsPass(dir) && /export function sub\s*\(/.test(read(dir, 'math.js')) && /sub\(/.test(read(dir, 'test.js')),
  },
  rename: {
    math: FIXED,
    prompt: 'Rename the function `mul` to `multiply` everywhere it is defined or used, then run npm test.',
    // Ignore string literals: the test's 'FAIL mul' message is not a use of the function.
    check: (dir) => {
      const code = (read(dir, 'math.js') + read(dir, 'test.js')).replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
      return testsPass(dir) && !/\bmul\b/.test(code) && /multiply/.test(read(dir, 'test.js'));
    },
  },
};

function findRollout(threadId) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (name.includes(threadId)) return full;
    }
    return undefined;
  };
  return walk(path.join(codexHome, 'sessions'));
}

const SHELL_WRITE = /Set-Content|Out-File|Add-Content|WriteAllText|New-Item|sed -i|(^|[^>])>\s*[\w.\\/]/i;

/** Tool-call statistics from Codex's own session log for the thread. */
function rolloutStats(threadId) {
  const stats = { editCalls: 0, editFailures: 0, shellWrites: 0, toolCalls: 0 };
  const file = threadId && findRollout(threadId);
  if (!file) return stats;
  const pendingNames = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const p = record.payload ?? {};
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      stats.toolCalls++;
      pendingNames.set(p.call_id, p.name);
      if (['apply_patch', 'edit_file', 'write_file'].includes(p.name)) stats.editCalls++;
      const cmd = p.type === 'function_call' && /exec_command|shell/.test(p.name) ? String(p.arguments) : '';
      if (cmd && SHELL_WRITE.test(cmd)) stats.shellWrites++;
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const name = pendingNames.get(p.call_id);
      const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      if (['apply_patch', 'edit_file', 'write_file'].includes(name) && /fail|error|invalid|rejected|declined|not found|verification/i.test(text) && !/^(Success|Updated|Created)/.test(text.replace(/^"|\\n/g, ''))) {
        stats.editFailures++;
      }
    }
  }
  return stats;
}

const settings = new SettingsStore(path.join(data, 'settings.json'));
settings.update({ review: false, deep: false, hedge: false, team: {} });
/** The agent engine for this OS and CPU, from node_modules. */
function engineBinary() {
  const { engineTarget, exe } = require(path.join(appRoot, 'out/main/platform.js'));
  const { pkg, triple } = engineTarget();
  return path.join(appRoot, 'node_modules', ...pkg.split('/'), 'vendor', triple, 'bin', exe('codex'));
}

const fcc = new FccSidecar({ projectDir: path.resolve(appRoot, '..', '_reference', 'free-claude-code'), homeDir: require(path.join(appRoot, 'out/main/paths.js')).moochPaths().gateway });

let current;
const agent = new AgentController({
  fcc,
  codexBinary: engineBinary(),
  codexHome,
  checkpointRoot: path.join(data, 'checkpoints'),
  raceRoot: path.join(data, 'races'),
  prompts: new PromptLibrary(path.join(appRoot, 'prompts')),
  settings,
  emit: (event) => {
    if (!current) return;
    if (event.kind === 'approval') agent.respond(event.request.requestId, 'accept');
    if (event.kind === 'thread') current.threadId = event.threadId;
    if (event.kind === 'tokenUsage') current.tokens = event.usage.total.totalTokens;
    // A turn that ends before this trial's thread exists is a leftover from the previous trial.
    if (event.kind === 'turnCompleted' && current.threadId) current.done(event.status);
  },
});

const results = [];
try {
  await fcc.start();
  const model = arg('model', (await fcc.modelList()).defaultModel);
  console.log(`model ${model}, ${trials} trial(s) × ${formats.length} format(s) × ${taskNames.length} task(s)`);
  for (let trial = 1; trial <= trials; trial++) {
    for (const task of taskNames) {
      // Alternate the order so neither format always runs first against a warm or cold provider.
      for (const format of trial % 2 ? formats : [...formats].reverse()) {
        const dir = path.join(data, `${task}-${format}-${trial}`);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'math.js'), TASKS[task].math);
        writeFileSync(path.join(dir, 'test.js'), TEST);
        writeFileSync(path.join(dir, 'package.json'), '{ "name": "bench", "type": "module", "scripts": { "test": "node test.js" } }\n');
        settings.update({ editTool: format });
        current = undefined;
        agent.setWorkspace(dir);
        let status = 'timeout';
        current = {};
        const finished = new Promise((resolve) => (current.done = (s) => resolve(s)));
        const started = Date.now();
        try {
          await agent.newThread({ model, mode: 'auto-edit' });
          await agent.send(TASKS[task].prompt);
          status = await Promise.race([finished, new Promise((r) => setTimeout(() => r('timeout'), 360_000))]);
        } catch (error) {
          status = `error: ${error.message}`;
        }
        if (status === 'timeout') {
          await agent.interrupt().catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        const row = { trial, task, format, status, success: TASKS[task].check(dir), seconds, tokens: current.tokens ?? 0, ...rolloutStats(current.threadId) };
        results.push(row);
        console.log(JSON.stringify(row));
        writeFileSync(path.join(data, 'results.json'), JSON.stringify(results, null, 2));
      }
    }
  }
} finally {
  agent.dispose();
  await fcc.stop();
}

const summarize = (format) => {
  const rows = results.filter((r) => r.format === format);
  const avg = (k) => (rows.reduce((s, r) => s + r[k], 0) / Math.max(rows.length, 1)).toFixed(1);
  return `| ${format} | ${rows.filter((r) => r.success).length}/${rows.length} | ${avg('seconds')} | ${avg('editCalls')} | ${avg('editFailures')} | ${avg('shellWrites')} | ${Math.round(Number(avg('tokens'))).toLocaleString()} |`;
};
console.log('\n| Format | Success | Avg seconds | Edit calls | Failed edits | Shell writes | Avg tokens |\n|---|---|---|---|---|---|---|');
for (const format of formats) console.log(summarize(format));
