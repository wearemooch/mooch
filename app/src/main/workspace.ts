// The open folder: path-guarded file access for the editor plus a change watcher.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry } from '../shared/ipc';

const HIDDEN = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', 'dist', 'out']);

export class Workspace {
  private watcher?: FSWatcher;
  private pending = new Set<string>();
  private flushTimer?: NodeJS.Timeout;

  constructor(
    readonly root: string,
    private readonly onChanged: (paths: string[]) => void,
  ) {}

  /** Resolves a path and refuses anything outside the workspace root. */
  resolve(target: string): string {
    const resolved = path.resolve(this.root, target);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the workspace: ${target}`);
    }
    return resolved;
  }

  async list(dir: string): Promise<DirEntry[]> {
    const absolute = this.resolve(dir);
    const items = await readdir(absolute, { withFileTypes: true });
    return items
      .filter((item) => !HIDDEN.has(item.name))
      .map((item) => ({ name: item.name, path: path.join(absolute, item.name), isDirectory: item.isDirectory() }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }

  read(file: string): Promise<string> {
    return readFile(this.resolve(file), 'utf8');
  }

  async write(file: string, content: string): Promise<void> {
    const absolute = this.resolve(file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }

  startWatching(): void {
    // Recursive fs.watch is supported natively on Windows and macOS.
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (name.split(/[\\/]/).some((part) => HIDDEN.has(part))) return;
      this.pending.add(path.join(this.root, name));
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        const paths = [...this.pending];
        this.pending.clear();
        this.onChanged(paths);
      }, 150);
    });
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.watcher?.close();
  }
}
