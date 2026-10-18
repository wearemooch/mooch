// Runs Free Claude Code (unmodified, AGPL) as a separate process: loopback only, proxy auth on,
// and its own home folder so it never touches the user's ~/.fcc.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { FccStatus, ModelList, ModelOption } from '../../shared/ipc';
import { endProcessesUnder, findExecutable, systemTool } from '../exec';
import { configuredModel, isCodingModel, pickDefaultModel } from './models';

const RETRY_LINE = /Provider transient error \((\w+)\), attempt (\d+)\/(\d+)/;
const ERROR_NAMES: Record<string, string> = {
  APITimeoutError: 'timed out',
  RateLimitError: 'is rate-limited',
  APIConnectionError: 'could not be reached',
  InternalServerError: 'returned a server error',
};

/** True when FCC's /admin/api/status no longer reports any provider or the model catalog as starting. */
export function fccStartupSettled(status: unknown): boolean {
  const startup = (status as { startup?: { catalog_file?: string; providers?: Record<string, string> } })?.startup;
  if (!startup) return false;
  const providers = Object.values(startup.providers ?? {});
  return startup.catalog_file !== 'starting' && providers.every((state) => state !== 'starting');
}

/** Turns FCC's "Provider transient error (APITimeoutError), attempt 2/5" log line into UI text. */
export function describeRetry(line: string): string | undefined {
  const match = RETRY_LINE.exec(line);
  if (!match) return undefined;
  const [, kind, attempt, max] = match;
  return `The model ${ERROR_NAMES[kind] ?? `failed (${kind})`}; retrying (attempt ${Number(attempt) + 1} of ${max}).`;
}

export interface FccSidecarOptions {
  /** Directory of the pinned FCC checkout, run with `uv run --frozen --project <dir> fcc-server`. */
  projectDir: string;
  /** Becomes HOME/USERPROFILE for FCC, so its config lives in <home>/.fcc. */
  homeDir: string;
  /** Absolute path to uv; defaults to the uv found on PATH. */
  uvCommand?: string;
  /**
   * Where uv keeps FCC's Python environment, its cache and the Python it downloads. Set for installed
   * builds, whose install folder must stay read-only; without it uv uses <projectDir>/.venv (dev checkout).
   */
  runtimeDir?: string;
  /** FCC's version, for builds that ship its source without git metadata (its version comes from git tags). */
  version?: string;
  startupTimeoutMs?: number;
}

/** uv's progress lines worth showing while the gateway is set up for the first time. */
const SETUP_LINE = /^\s*(Downloading|Downloaded|Installing|Installed|Prepared|Resolved|Building|Built|Using CPython|Creating virtual environment)\b/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Events: 'status' (FccStatus), 'log' (line: string), 'retry' (message: string) */
const TOKEN_LINE = /^ANTHROPIC_AUTH_TOKEN=(.*)$/m;

/**
 * FCC ignores ANTHROPIC_AUTH_TOKEN from the process environment and reads it from its managed
 * <home>/.fcc/.env, so we keep our own random token there. If the file doesn't exist yet,
 * FCC's own first-run migration adopts the line and adds its schema marker.
 */
function ensureProxyToken(homeDir: string): string {
  const envPath = path.join(homeDir, '.fcc', '.env');
  mkdirSync(path.dirname(envPath), { recursive: true });
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const current = TOKEN_LINE.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (current && current !== 'freecc') return current;
  const token = randomBytes(24).toString('hex');
  const withoutOld = text.replace(TOKEN_LINE, '').replace(/\n{3,}/g, '\n\n');
  const prefix = withoutOld && !withoutOld.endsWith('\n') ? `${withoutOld}\n` : withoutOld;
  writeFileSync(envPath, `${prefix}ANTHROPIC_AUTH_TOKEN=${token}\n`, 'utf8');
  return token;
}

export class FccSidecar extends EventEmitter {
  private proxyToken = '';
  private child?: ChildProcess;
  private port?: number;
  private status: FccStatus = { state: 'stopped' };
  private stopping = false;

  constructor(private readonly options: FccSidecarOptions) {
    super();
  }

  /** Bearer token clients must send; valid after start(). */
  get token(): string {
    return this.proxyToken;
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }

  get modelCatalogPath(): string {
    return path.join(this.options.homeDir, '.fcc', 'codex-model-catalog.json');
  }

  getStatus(): FccStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    mkdirSync(this.options.homeDir, { recursive: true });
    this.proxyToken = ensureProxyToken(this.options.homeDir);
    await this.endLeftovers();
    this.port = await freePort();
    this.setStatus({ state: 'starting', url: this.url });

    const uv = this.options.uvCommand ?? findExecutable('uv');
    if (!uv) {
      this.setStatus({ state: 'error', message: 'uv was not found, so the model gateway cannot start.' });
      throw new Error('uv was not found.');
    }
    const runtime = this.options.runtimeDir;
    const firstRun = runtime ? !existsSync(path.join(runtime, 'venv')) : false;
    if (firstRun) this.setStatus({ state: 'starting', url: this.url, message: 'First start: setting up the model gateway. This downloads about 300 MB and can take a few minutes.' });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(runtime
        ? {
            UV_PROJECT_ENVIRONMENT: path.join(runtime, 'venv'),
            UV_CACHE_DIR: path.join(runtime, 'uv-cache'),
            UV_PYTHON_INSTALL_DIR: path.join(runtime, 'python'),
            UV_NO_CONFIG: '1', // the user's own uv.toml must not change how the gateway is installed
            // The gateway's Python is private to the app: no python3.x.exe shim in ~/.local/bin and no
            // Windows registry entry (with them, uv's install also failed on its version link).
            UV_PYTHON_INSTALL_BIN: '0',
            UV_PYTHON_INSTALL_REGISTRY: '0',
          }
        : {}),
      // The gateway's version comes from git tags, which a shipped copy doesn't have. hatch-vcs doesn't pass
      // a package name to setuptools-scm, so only the generic form works.
      ...(this.options.version ? { SETUPTOOLS_SCM_PRETEND_VERSION: this.options.version } : {}),
      HOME: this.options.homeDir,
      USERPROFILE: this.options.homeDir,
      HOST: '127.0.0.1',
      PORT: String(this.port),
      FCC_OPEN_BROWSER: 'false',
      PROXY_AUTH_ENABLED: 'true',
      PYTHONUNBUFFERED: '1',
    };
    const child = spawn(
      uv,
      ['run', '--frozen', '--no-dev', '--project', this.options.projectDir, 'fcc-server'],
      // On macOS and Linux the gateway gets its own process group, so stop() can end uv and Python together.
      { cwd: this.options.projectDir, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.emit('log', line);
        if (this.status.state === 'starting' && SETUP_LINE.test(line)) this.setStatus({ state: 'starting', url: this.url, message: `Setting up the model gateway: ${line.trim()}` });
        const retry = describeRetry(line);
        if (retry) this.emit('retry', retry);
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', (error) => this.setStatus({ state: 'error', message: `Could not run uv: ${error.message}` }));
    child.on('exit', (code) => {
      this.child = undefined;
      if (!this.stopping) this.setStatus({ state: 'error', message: `The model gateway stopped unexpectedly (code ${code ?? 'unknown'}).` });
      else this.setStatus({ state: 'stopped' });
    });

    // The first start installs Python and FCC's dependencies before the server can answer.
    await this.waitForHealth(this.options.startupTimeoutMs ?? (firstRun ? 20 * 60_000 : 90_000));
    await this.waitForProviders(30_000);
    this.setStatus({ state: 'running', url: this.url });
  }

  /** The folder the gateway's Python processes run from. */
  private get environmentDir(): string {
    return this.options.runtimeDir ?? path.join(this.options.projectDir, '.venv');
  }

  /**
   * Ends gateway processes left by an earlier session that crashed or was killed (Windows doesn't end
   * child processes with their parent, and a leftover gateway holds the config lock). Safe because only
   * one copy of the app runs, and nothing else runs programs from the gateway's private environment.
   */
  private async endLeftovers(): Promise<void> {
    if (!existsSync(this.environmentDir)) return;
    const ended = await endProcessesUnder(this.environmentDir);
    if (ended) this.emit('log', `Ended ${ended} gateway process(es) left running by an earlier session.`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.stopping = true;
    if (process.platform === 'win32') {
      // `uv run` starts Python as a child process, so kill the whole tree.
      await new Promise<void>((resolve) => execFile(systemTool('taskkill'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      // If uv went first, its Python children are no longer in its tree.
      await endProcessesUnder(this.environmentDir);
    } else {
      const group = -child.pid;
      try {
        process.kill(group, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        process.kill(group, 'SIGKILL');
      } catch {
        // already gone
      }
      await endProcessesUnder(this.environmentDir);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.start();
  }

  /** Models FCC publishes for Codex (written to <home>/.fcc/codex-model-catalog.json). */
  async models(): Promise<ModelOption[]> {
    try {
      const catalog = JSON.parse(await readFile(this.modelCatalogPath, 'utf8')) as {
        models?: { slug: string; display_name?: string }[];
      };
      return (catalog.models ?? []).map((m) => ({ slug: m.slug, displayName: m.display_name ?? m.slug }));
    } catch {
      return [];
    }
  }

  /** Coding-capable models plus the one to preselect (the MODEL set in FCC's Model Config). */
  async modelList(): Promise<ModelList> {
    const models = (await this.models()).filter((m) => isCodingModel(m.slug));
    let envText = '';
    try {
      envText = await readFile(path.join(this.options.homeDir, '.fcc', '.env'), 'utf8');
    } catch {
      // not created yet
    }
    return { models, defaultModel: pickDefaultModel(models, configuredModel(envText)) };
  }

  /**
   * /health answers before FCC has loaded provider keys and republished the model catalog. A request
   * in that window fails with "API key is not set", and the catalog on disk may still be the previous
   * run's. So wait until FCC's own startup status says providers and catalog are no longer starting.
   */
  private async waitForProviders(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.child) {
      try {
        const response = await fetch(`${this.url}/admin/api/status`, { signal: AbortSignal.timeout(2000) });
        if (response.ok && fccStartupSettled(await response.json())) return;
      } catch {
        // not ready to answer yet
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.emit('log', 'Providers were still starting after 30s; continuing anyway.');
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(this.status.message ?? 'The model gateway stopped during startup.');
      try {
        const response = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.setStatus({ state: 'error', message: 'The model gateway did not start in time.' });
    throw new Error('The model gateway did not start in time.');
  }

  private setStatus(status: FccStatus): void {
    this.status = status;
    this.emit('status', status);
  }
}
