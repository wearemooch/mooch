// Gathers everything that ships next to the app (electron-builder copies build/stage into resources/):
//   codex/     the agent engine (OpenAI Codex), without its optional voice libraries
//   gateway/   the model gateway's complete source (Free Claude Code, unmodified, AGPL-3.0)
//   bin/uv(.exe) installs and runs the gateway
//   versions.json, notices/THIRD_PARTY_NOTICES.md, icon.ico / icon.png
//
// Stages for the OS and CPU it runs on (release builds are made natively on each OS).
// Usage: node scripts/stage.mjs   (FCC_SOURCE=<checkout>, UV_BINARY=<uv binary> override the defaults)
// License texts that aren't in node_modules are downloaded from the projects' own repositories at
// the bundled versions, so a release always carries the full texts.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const stage = path.join(appRoot, 'build', 'stage');
const nodeModules = path.join(appRoot, 'node_modules');
const fccSource = process.env.FCC_SOURCE ?? path.resolve(appRoot, '..', '_reference', 'free-claude-code');
// Same table as src/main/platform.ts.
const ENGINE_TARGETS = {
  'win32-x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  'darwin-x64': ['codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin'],
  'linux-x64': ['codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['codex-linux-arm64', 'aarch64-unknown-linux-musl'],
};
const target = ENGINE_TARGETS[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`No agent engine build for ${process.platform}-${process.arch}.`);
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const codexVendor = path.join(nodeModules, '@openai', target[0], 'vendor', target[1]);

const log = (...args) => console.log('[stage]', ...args);
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, ...options }).trim();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && path.isAbsolute(dir) && existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`);
  return response.text();
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// --- Agent engine -------------------------------------------------------------------------------
if (!existsSync(path.join(codexVendor, 'bin', exe('codex')))) throw new Error('Codex is not installed; run npm install first.');
cpSync(codexVendor, path.join(stage, 'codex'), {
  recursive: true,
  // Voice (GStreamer/GLib, LGPL) is never used by the app.
  filter: (src) => !src.includes(`${path.sep}codex-resources${path.sep}voice`),
});
const codexVersion = readJson(path.join(nodeModules, '@openai', 'codex', 'package.json')).version;
const rgVersion = run(path.join(codexVendor, 'codex-path', exe('rg')), ['--version']).split(/\s+/)[1];
log('agent engine', codexVersion, '(ripgrep', `${rgVersion})`);

// --- Model gateway (complete source, unmodified) -------------------------------------------------
const SKIP = new Set(['.git', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'node_modules']);
cpSync(fccSource, path.join(stage, 'gateway'), { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
const gatewayTag = run('git', ['-C', fccSource, 'describe', '--tags', '--abbrev=0']);
const gatewayCommit = run('git', ['-C', fccSource, 'rev-parse', 'HEAD']);
if (run('git', ['-C', fccSource, 'status', '--porcelain', '--untracked-files=no'])) {
  throw new Error(`The gateway checkout at ${fccSource} has local changes; releases ship it unmodified.`);
}
const gatewayVersion = gatewayTag.replace(/^v/, '');
const gatewayRepo = run('git', ['-C', fccSource, 'remote', 'get-url', 'origin']).replace(/\.git$/, '');
log('gateway', gatewayVersion, gatewayCommit.slice(0, 10));

// --- uv ------------------------------------------------------------------------------------------
const uv = process.env.UV_BINARY ?? findOnPath(exe('uv'));
if (!uv) throw new Error(`${exe('uv')} not found; install uv or set UV_BINARY.`);
mkdirSync(path.join(stage, 'bin'), { recursive: true });
cpSync(uv, path.join(stage, 'bin', exe('uv')));
const uvVersion = run(uv, ['--version']).split(/\s+/)[1];
log('uv', uvVersion);

writeFileSync(
  path.join(stage, 'versions.json'),
  JSON.stringify({ codex: codexVersion, gateway: gatewayVersion, gatewayCommit, gatewayRepo, uv: uvVersion, ripgrep: rgVersion }, null, 2),
);

// The window icon: .ico on Windows, .png on Linux (macOS takes it from the app bundle).
for (const icon of ['icon.ico', 'icon.png']) {
  const file = path.join(appRoot, 'build', icon);
  if (existsSync(file)) cpSync(file, path.join(stage, icon));
}

// --- Third-party notices -------------------------------------------------------------------------
/** npm packages that ship: the main process's dependencies plus everything bundled into the window. */
const SHIPPED_ROOTS = ['diff', 'react', 'react-dom', 'zustand', 'react-markdown', 'remark-gfm', 'monaco-editor', '@monaco-editor/react', '@fontsource/inter', '@fontsource/jetbrains-mono', '@phosphor-icons/react', 'material-icon-theme', 'fflate', 'electron'];

function packageDir(name, from = appRoot) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
  return file ? readFileSync(path.join(dir, file), 'utf8').trim() : undefined;
}

const packages = new Map();
function collect(name, from) {
  const dir = packageDir(name, from);
  if (!dir || packages.has(dir)) return;
  const pkg = readJson(path.join(dir, 'package.json'));
  packages.set(dir, pkg);
  // electron's runtime dependencies are only its downloader; the binary's licenses ship with it.
  if (name === 'electron') return;
  for (const dep of Object.keys(pkg.dependencies ?? {})) collect(dep, dir);
}
SHIPPED_ROOTS.forEach((name) => collect(name, appRoot));

const sections = [];
const section = (title, meta, text) => sections.push(`## ${title}\n\n${meta}\n\n\`\`\`\n${text.trim()}\n\`\`\``);

section(
  `Free Claude Code ${gatewayVersion}`,
  [
    'The model gateway. License: AGPL-3.0-only.',
    'Included unmodified and run as a separate program. Its complete source code is included in the',
    '`gateway` folder of this installation, and is available at',
    `${gatewayRepo}/tree/${gatewayCommit}.`,
    'Its Python dependencies are downloaded from PyPI on first start under their own licenses.',
  ].join('\n'),
  readFileSync(path.join(fccSource, 'LICENSE'), 'utf8'),
);
const codexRef = `rust-v${codexVersion}`;
section(
  `OpenAI Codex CLI ${codexVersion}`,
  `The agent engine. License: Apache-2.0. Source: https://github.com/openai/codex/tree/${codexRef}`,
  [await download(`https://raw.githubusercontent.com/openai/codex/${codexRef}/LICENSE`), await download(`https://raw.githubusercontent.com/openai/codex/${codexRef}/NOTICE`).catch(() => '')]
    .filter(Boolean)
    .join('\n\n'),
);
section(
  `ripgrep ${rgVersion}`,
  `Bundled with the agent engine. License: MIT OR Unlicense. Source: https://github.com/BurntSushi/ripgrep/tree/${rgVersion}`,
  await download(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/LICENSE-MIT`),
);
section(
  `uv ${uvVersion}`,
  `Installs and runs the model gateway. License: MIT OR Apache-2.0. Source: https://github.com/astral-sh/uv/tree/${uvVersion}`,
  await download(`https://raw.githubusercontent.com/astral-sh/uv/${uvVersion}/LICENSE-MIT`),
);

const npmEntries = [...packages.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name));
const missing = [];
for (const [dir, pkg] of npmEntries) {
  const text = licenseText(dir);
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package');
  if (!text) missing.push(`${pkg.name}@${pkg.version} (${license})`);
  section(`${pkg.name} ${pkg.version}`, `License: ${license}.${pkg.name === 'electron' ? ' Chromium\'s licenses are in LICENSES.chromium.html in the installation folder.' : ''}`, text ?? `${license} (the package ships no license file).`);
}

const header = [
  '# Third-party notices',
  '',
  'This app includes or downloads the third-party software listed below. Each component is',
  'distributed under its own license, reproduced in full in its section.',
  '',
];
mkdirSync(path.join(stage, 'notices'), { recursive: true });
writeFileSync(path.join(stage, 'notices', 'THIRD_PARTY_NOTICES.md'), `${header.join('\n')}\n${sections.join('\n\n')}\n`, 'utf8');
log('notices:', sections.length, 'components');
if (missing.length) log('packages without a license file (license named from package.json):', missing.join(', '));
log('done:', stage);
