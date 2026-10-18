// Snapshot of the workspace's text files at the start of a turn, so the review sees every change the
// agent made: apply_patch edits as well as files written by shell commands.
import { createTwoFilesPatch } from 'diff';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileUpdateChange } from '../../shared/ipc';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build', 'target', '.smoke-data', '.pytest_cache']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 8_000;

/** Relative path → text content. Undefined when the workspace is too big to snapshot cheaply. */
export type TurnSnapshot = Map<string, string>;

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

async function collect(root: string): Promise<TurnSnapshot | undefined> {
  const files: TurnSnapshot = new Map();
  let total = 0;
  let tooBig = false;
  async function walk(rel: string): Promise<void> {
    if (tooBig) return;
    let items;
    try {
      items = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (SKIP.has(item.name)) continue;
      const relative = rel ? path.join(rel, item.name) : item.name;
      if (item.isDirectory()) await walk(relative);
      else if (item.isFile()) {
        const absolute = path.join(root, relative);
        const { size } = await stat(absolute);
        if (size > MAX_FILE_BYTES) continue;
        total += size;
        if (total > MAX_TOTAL_BYTES || files.size >= MAX_FILES) {
          tooBig = true;
          return;
        }
        const buffer = await readFile(absolute);
        if (!looksBinary(buffer)) files.set(relative, buffer.toString('utf8'));
      }
    }
  }
  await walk('');
  return tooBig ? undefined : files;
}

export function captureSnapshot(root: string): Promise<TurnSnapshot | undefined> {
  return collect(root);
}

/** Unified diffs of every text file that changed, was added, or was deleted since `before`. */
export async function changesSince(root: string, before: TurnSnapshot): Promise<FileUpdateChange[]> {
  const after = (await collect(root)) ?? new Map();
  const changes: FileUpdateChange[] = [];
  const toPatch = (file: string, a: string, b: string) => createTwoFilesPatch(`a/${file}`, `b/${file}`, a, b, '', '', { context: 3 });
  for (const [file, content] of after) {
    const previous = before.get(file);
    if (previous === undefined) changes.push({ path: file, kind: { type: 'add' }, diff: toPatch(file, '', content) });
    else if (previous !== content) changes.push({ path: file, kind: { type: 'update', move_path: null }, diff: toPatch(file, previous, content) });
  }
  for (const [file, content] of before) {
    if (!after.has(file)) changes.push({ path: file, kind: { type: 'delete' }, diff: toPatch(file, content, '') });
  }
  return changes;
}
