// Restore points for a workspace, stored in a private "shadow" git repository in mooch's data
// folder. The project's own .git is never read or written; the project's .gitignore files are honored.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findExecutable } from '../exec';

/** Never snapshotted, even without a .gitignore: dependencies, caches and build output that are regenerated. */
const DEFAULT_EXCLUDES = [
  '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/', '.next/', '.turbo/',
  'target/', '.gradle/', '.idea/', '*.log', '.DS_Store', 'Thumbs.db',
];

/** Restore points between housekeeping runs of the shadow repository. */
const GC_EVERY = 30;

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
}

export interface FileStatus {
  path: string;
  /** What restoring would do to this file. */
  action: 'restore' | 'delete' | 'recreate';
}

export class CheckpointError extends Error {}

export class ShadowGit {
  readonly gitDir: string;
  private ready?: Promise<void>;
  /** git operations on one repository must not overlap (they share the index). */
  private queue: Promise<unknown> = Promise.resolve();
  private created = 0;

  constructor(
    readonly workspace: string,
    storeRoot: string,
  ) {
    const key = createHash('sha1').update(path.resolve(workspace).toLowerCase()).digest('hex').slice(0, 16);
    this.gitDir = path.join(storeRoot, `${path.basename(workspace).replace(/[^\w.-]/g, '_')}-${key}.git`);
  }

  /** Records the current state of the workspace. Returns the restore point (also when nothing changed). */
  create(label: string): Promise<Checkpoint> {
    return this.serial(async () => {
      await this.init();
      await this.git(['add', '-A', '--', '.']);
      await this.git(['commit', '--allow-empty', '--no-verify', '-q', '-m', label]);
      const id = (await this.git(['rev-parse', 'HEAD'])).trim();
      // Every commit adds loose objects; pack them now and then so the store stays small. In the
      // foreground (no detached gc), so it never races the next checkpoint for the repository.
      if (++this.created % GC_EVERY === 0) {
        // With the shadow --git-dir: never the project's own repository.
        await this.git(['-c', 'gc.auto=1000', '-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet']).catch(() => undefined);
      }
      return { id, label, createdAt: Date.now() };
    });
  }

  /** What restoring `id` would change, compared with the files as they are right now. */
  preview(id: string): Promise<FileStatus[]> {
    return this.serial(async () => {
      await this.init();
      await this.git(['add', '-A', '--', '.']);
      const output = await this.git(['diff', '--cached', '--name-status', '--no-renames', '-z', id]);
      const parts = output.split('\0').filter(Boolean);
      const files: FileStatus[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i];
        const file = parts[i + 1];
        // Status is from the checkpoint to now: A = created since (restore deletes it), D = deleted since.
        files.push({ path: file, action: status === 'A' ? 'delete' : status === 'D' ? 'recreate' : 'restore' });
      }
      return files;
    });
  }

  /** Puts every tracked file back the way it was at `id`, deleting files created since then. */
  restore(id: string): Promise<FileStatus[]> {
    return this.serial(async () => {
      await this.init();
      await this.git(['add', '-A', '--', '.']);
      const output = await this.git(['diff', '--cached', '--name-status', '--no-renames', '-z', id]);
      if (!output.trim()) return [];
      await this.git(['restore', `--source=${id}`, '--staged', '--worktree', '--', '.']);
      const parts = output.split('\0').filter(Boolean);
      const files: FileStatus[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        files.push({ path: parts[i + 1], action: parts[i] === 'A' ? 'delete' : parts[i] === 'D' ? 'recreate' : 'restore' });
      }
      return files;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      if (!existsSync(path.join(this.gitDir, 'HEAD'))) {
        await mkdir(this.gitDir, { recursive: true });
        await this.git(['init', '-q', '--bare', this.gitDir], false);
        await mkdir(path.join(this.gitDir, 'info'), { recursive: true });
        await writeFile(path.join(this.gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`, 'utf8');
        // An empty hooks folder: the user's global hooks must never run on these commits.
        await mkdir(path.join(this.gitDir, 'no-hooks'), { recursive: true });
      }
    })();
    return this.ready;
  }

  private git(args: string[], withWorkTree = true): Promise<string> {
    const base = [
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'core.longpaths=true',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${path.join(this.gitDir, 'no-hooks')}`,
      '-c', 'commit.gpgsign=false',
      '-c', 'user.name=mooch',
      '-c', 'user.email=checkpoints@mooch.local',
      '-c', 'gc.auto=0',
    ];
    const location = withWorkTree ? [`--git-dir=${this.gitDir}`, `--work-tree=${this.workspace}`] : [];
    const git = findExecutable('git');
    if (!git) return Promise.reject(new CheckpointError('Git is not installed, so restore points are off. Install Git for Windows to enable them.'));
    return new Promise((resolve, reject) => {
      execFile(
        git,
        [...base, ...location, ...args],
        { cwd: this.workspace, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (error, stdout, stderr) => {
          if (error) reject(new CheckpointError(`git ${args[0]} failed: ${(stderr || error.message).trim().split('\n')[0]}`));
          else resolve(stdout);
        },
      );
    });
  }
}
