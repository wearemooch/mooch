// Copies of the workspace for race contestants, and applying a winner's changes back.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestResult } from '../../shared/ipc';
import { isReallyInside } from '../realPath';

/** Too big or regenerable to copy; contestants share the original through a directory link. */
const LINKED = new Set(['node_modules', '.venv', 'venv']);
/** Not needed in a contestant's copy. */
const SKIPPED = new Set(['.git', '__pycache__', '.pytest_cache', '.mypy_cache', '.next', '.turbo', '.smoke-data']);

const MAX_FILES = 20_000;
const MAX_BYTES = 500 * 1024 * 1024;

/** Relative path → sha1 of the content, for every file a contestant may change. */
export type Snapshot = Map<string, string>;

async function hashFile(file: string): Promise<string> {
  return createHash('sha1').update(await readFile(file)).digest('hex');
}

async function walk(root: string, onFile: (relative: string) => Promise<void>, rel = ''): Promise<void> {
  for (const item of await readdir(path.join(root, rel), { withFileTypes: true })) {
    if (LINKED.has(item.name) || SKIPPED.has(item.name)) continue;
    const relative = rel ? path.join(rel, item.name) : item.name;
    if (item.isDirectory()) await walk(root, onFile, relative);
    else if (item.isFile()) await onFile(relative);
  }
}

export async function snapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = new Map();
  await walk(root, async (relative) => void result.set(relative, await hashFile(path.join(root, relative))));
  return result;
}

/** Copies `source` to `target` (empty or missing), linking heavy dependency folders instead of copying them. */
export async function copyWorkspace(source: string, target: string): Promise<{ links: string[] }> {
  let files = 0;
  let bytes = 0;
  await walk(source, async (relative) => {
    files++;
    bytes += (await stat(path.join(source, relative))).size;
    if (files > MAX_FILES || bytes > MAX_BYTES) {
      throw new Error(`This project is too big to race (over ${MAX_FILES.toLocaleString()} files or 500 MB, not counting dependencies).`);
    }
  });
  await mkdir(target, { recursive: true });
  await walk(source, async (relative) => {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, relative), destination);
  });
  const links: string[] = [];
  async function linkDependencies(rel: string): Promise<void> {
    for (const item of await readdir(path.join(source, rel), { withFileTypes: true })) {
      if (!item.isDirectory() || SKIPPED.has(item.name)) continue;
      const relative = rel ? path.join(rel, item.name) : item.name;
      if (LINKED.has(item.name)) {
        const link = path.join(target, relative);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(path.join(source, relative), link, 'junction');
        links.push(link);
      } else {
        await linkDependencies(relative);
      }
    }
  }
  await linkDependencies('');
  return { links };
}

export interface CopyChanges {
  changed: string[];
  added: string[];
  deleted: string[];
}

export async function diffAgainst(copyRoot: string, baseline: Snapshot): Promise<CopyChanges> {
  const current = await snapshot(copyRoot);
  const changes: CopyChanges = { changed: [], added: [], deleted: [] };
  for (const [file, hash] of current) {
    if (!baseline.has(file)) changes.added.push(file);
    else if (baseline.get(file) !== hash) changes.changed.push(file);
  }
  for (const file of baseline.keys()) if (!current.has(file)) changes.deleted.push(file);
  return changes;
}

/**
 * Copies a contestant's changes into the real workspace. A file the user changed after the race
 * started (its hash no longer matches the baseline) is skipped rather than overwritten.
 */
export async function applyChanges(copyRoot: string, workspace: string, baseline: Snapshot, changes: CopyChanges) {
  const written: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  const untouched = async (file: string) => {
    const target = path.join(workspace, file);
    // Links in the real project are left out of copies, so a contestant can put a plain folder of
    // the same name in its copy; writing that back would follow the real link out of the project.
    if (!isReallyInside(workspace, target)) return false;
    if (!baseline.has(file)) return !existsSync(target);
    return existsSync(target) && (await hashFile(target)) === baseline.get(file);
  };
  for (const file of [...changes.changed, ...changes.added]) {
    if (!(await untouched(file))) {
      skipped.push(file);
      continue;
    }
    const target = path.join(workspace, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(copyRoot, file)));
    written.push(file);
  }
  for (const file of changes.deleted) {
    if (!(await untouched(file))) {
      skipped.push(file);
      continue;
    }
    await rm(path.join(workspace, file), { force: true });
    deleted.push(file);
  }
  return { written, deleted, skipped };
}

/**
 * Deletes `dir` without ever following a link: junctions and symlinks are unlinked, not entered. Used
 * for copies left behind by a crash, whose list of links is lost; their node_modules junctions point at
 * the user's real project.
 */
export async function removeTreeNoFollow(dir: string): Promise<void> {
  let info;
  try {
    info = await lstat(dir);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return unlink(dir).catch(() => rm(dir, { force: true }));
  if (!info.isDirectory()) return rm(dir, { force: true });
  for (const name of await readdir(dir)) await removeTreeNoFollow(path.join(dir, name));
  await rmdir(dir);
}

/** Removes a race copy. Directory links are unlinked first so the shared originals are never touched. */
export async function removeCopy(copyRoot: string, links: string[]): Promise<void> {
  for (const link of links) {
    try {
      if ((await lstat(link)).isSymbolicLink()) await unlink(link);
    } catch {
      // already gone
    }
  }
  await rm(copyRoot, { recursive: true, force: true });
}

export async function detectTestCommand(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const test = pkg.scripts?.test;
    if (test && !/no test specified/.test(test)) return 'npm test';
  } catch {
    // no package.json
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(path.join(root, 'go.mod'))) return 'go test ./...';
  if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => existsSync(path.join(root, f))) && existsSync(path.join(root, 'tests'))) {
    return 'python -m pytest -q';
  }
  return undefined;
}

/** What a test run needs to find its tools; mooch's own variables (tokens, API keys) stay out. */
const TEST_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USER', 'USERNAME',
  'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
]);

export function testEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CI: '1' };
  for (const [name, value] of Object.entries(env)) if (value !== undefined && TEST_ENV.has(name.toUpperCase())) result[name] = value;
  return result;
}

export function runTests(command: string, cwd: string, timeoutMs = 180_000): Promise<TestResult> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: testEnvironment(process.env) });
    const collect = (chunk: Buffer) => (output = (output + chunk.toString('utf8')).slice(-6000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      output += `\n(stopped after ${timeoutMs / 1000}s)`;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, passed: code === 0, exitCode: code, output: output.trim() });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ command, passed: false, exitCode: null, output: error.message });
    });
  });
}
