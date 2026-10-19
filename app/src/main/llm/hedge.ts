// Local proxy between Codex and FCC. It keeps a turn from hanging on a busy free model:
// when the model fails, stalls, or was busy a moment ago, the request also goes to a backup model,
// and whichever starts producing output first wins; the other request is aborted. With hedging on,
// the backup is asked as soon as the model is merely slow. If no model answers at all, the request
// ends with a plain error instead of waiting out the gateway's own retries.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { providerName, shortModelName } from '../../shared/modelNames';
import { ModelHealth } from './modelHealth';
import { isModelOutput, SseParser } from './sse';

export interface HedgeConfig {
  upstream(): { url: string; token: string } | undefined;
  /** Models that can stand in for `model`, best first; empty to never fall back. */
  backupsFor(model: string): string[];
  /** Hedging: ask the backup once the model is slow (after `delayMs`), not only when it stalls. */
  enabled(): boolean;
  delayMs(): number;
  /** A passing status while waiting ("X is slow right now. Asked Y too."). */
  onStatus(message: string, note?: boolean): void;
  /** Which model answered a request: the one asked for, or a backup and why it stood in. */
  onAnswered?(answer: Answer): void;
  /** No model answered the request; it ends with an error. */
  onUnavailable?(failure: Unavailable): void;
  health?: ModelHealth;
  /** No output for this long counts as a stall, even with hedging off. */
  stallMs?: number;
  /** No output from any model for this long ends the request with an error. */
  giveUpMs?: number;
}

/**
 * Why a backup answered instead of the model asked for. 'overloaded' (its limit, or the provider is
 * full) and 'failing' mean it is out for a while; the others mean it was merely slower this time.
 */
export type StandInReason = 'slow' | 'not answering' | 'busy' | 'overloaded' | 'failing';

export interface Answer {
  requested: string;
  model: string;
  reason?: StandInReason;
}

export interface Unavailable {
  requested: string;
  tried: string[];
  /** 'limit': rate-limited or overloaded; 'failed': errors; 'silent': no answer in time. */
  why: 'limit' | 'failed' | 'silent';
}

const STALL_MS = 40_000;
const GIVE_UP_MS = 150_000;

/** Only Codex's model calls go through; the gateway's admin API stays out of reach. */
const ALLOWED_PATH = /^\/v1\/(responses|models)(\/|\?|$)/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Why a request must be refused, or undefined to serve it. Requires the gateway token (which only
 * mooch and its Codex know), a loopback Host header (defeats DNS rebinding from web pages) and
 * no Origin header (browsers always send one on cross-origin requests; Codex never does).
 */
export function rejectReason(req: Pick<http.IncomingMessage, 'url' | 'headers'>, token: string): string | undefined {
  if (!ALLOWED_PATH.test(req.url ?? '')) return 'not found';
  if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return 'bad host';
  if (req.headers.origin) return 'cross-origin requests are not allowed';
  if (!token || req.headers.authorization !== `Bearer ${token}`) return 'unauthorized';
  return undefined;
}

const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding']);

function forwardHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Statuses free tiers use for "too busy right now". */
function isOverloaded(status: number | undefined): boolean {
  return status === 429 || status === 503 || status === 529;
}

interface Attempt {
  model: string;
  controller: AbortController;
  /** Raw bytes received before the attempt won, replayed to the client. */
  buffered: Uint8Array[];
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  status?: number;
  errorBody?: string;
}

export class HedgeProxy {
  private server?: http.Server;
  private port?: number;
  private readonly health: ModelHealth;

  constructor(private readonly config: HedgeConfig) {
    this.health = config.health ?? new ModelHealth();
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }

  async start(): Promise<string> {
    if (this.url) return this.url;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: Error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Model proxy: ${error.message}` } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.url!;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const upstream = this.config.upstream();
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The model gateway is not running.' } }));
      return;
    }
    const refused = rejectReason(req, upstream.token);
    if (refused) {
      res.writeHead(refused === 'not found' ? 404 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: refused } }));
      return;
    }
    const body = await readBody(req);
    const headers = forwardHeaders(req.headers);
    const target = `${upstream.url}${req.url ?? '/'}`;

    let json: { model?: string } | undefined;
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = undefined;
      }
    }
    if (!json?.model) {
      await this.passThrough(target, req.method ?? 'GET', headers, body, res);
      return;
    }
    const model = json.model;
    const backup = this.health.pick(this.config.backupsFor(model).filter((m) => m !== model));
    await this.guarded(target, headers, json as { model: string }, backup, res);
  }

  private async passThrough(target: string, method: string, headers: Record<string, string>, body: Buffer, res: http.ServerResponse): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const response = await fetch(target, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal: controller.signal });
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !HOP_HEADERS.has(k) && k !== 'content-encoding')));
    if (!response.body) return void res.end();
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    } catch {
      // client or upstream went away
    }
    res.end();
  }

  private async guarded(target: string, headers: Record<string, string>, request: { model: string }, backupModel: string | undefined, res: http.ServerResponse): Promise<void> {
    const primary = request.model;
    const attempts: Attempt[] = [];
    let settled = false;
    let backupStarted = false;
    let primaryStarted = false;
    let backupReason: StandInReason = 'slow';
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const timers: NodeJS.Timeout[] = [];

    const abortAll = () => attempts.forEach((a) => a.controller.abort());
    const settle = () => {
      settled = true;
      timers.forEach(clearTimeout);
    };
    res.on('close', () => {
      timers.forEach(clearTimeout);
      abortAll();
      resolveDone();
    });

    /** Ends the request with a plain explanation. 400 so Codex shows it as the turn's error rather than retrying. */
    const fail = (message: string) => {
      if (settled) return;
      settle();
      abortAll();
      const why = attempts.some((a) => isOverloaded(a.status)) ? 'limit' : attempts.some((a) => a.status !== undefined) ? 'failed' : 'silent';
      this.config.onUnavailable?.({ requested: primary, tried: attempts.map((a) => a.model), why });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'model_unavailable', message } }));
      resolveDone();
    };

    const noAnswerMessage = (why: string) => {
      const tried = attempts.map((a) => shortModelName(a.model)).join(' and ');
      const providers = new Set(attempts.map((a) => providerName(a.model)));
      const where = providers.size === 1 ? `${[...providers][0]}'s free tier` : 'their free tiers';
      return `${why} ${tried} ${attempts.length === 1 ? 'is' : 'are'} probably overloaded on ${where}. Try again in a minute, or pick another model.`;
    };

    const attemptFailed = (attempt: Attempt) => {
      if (settled) return;
      const clientError = attempt.status !== undefined && attempt.status >= 400 && attempt.status < 500 && !isOverloaded(attempt.status);
      if (!clientError) this.health.markBusy(attempt.model);
      if (attempt.model === primary && !clientError && backupStarted) {
        // The backup was already asked because the model was slow; now the model failed outright.
        backupReason = isOverloaded(attempt.status) ? 'overloaded' : 'failing';
      }
      if (attempt.model === primary && backupModel && !backupStarted) {
        return void startBackup(isOverloaded(attempt.status) ? 'is overloaded right now' : 'failed', isOverloaded(attempt.status) ? 'overloaded' : 'failing');
      }
      // We skipped a busy model for its backup, and the backup failed: the model may have recovered.
      if (attempt.model !== primary && !primaryStarted) return void startPrimary();
      if (attempts.some((a) => a.status === undefined && !a.controller.signal.aborted)) return; // someone still running
      // A request the gateway rejected (bad input, context too long…) goes back to Codex as it was.
      const rejected = attempts.find((a) => a.model === primary && a.status !== undefined && a.status >= 400 && a.status < 500 && !isOverloaded(a.status));
      if (rejected) {
        settle();
        res.writeHead(rejected.status!, { 'content-type': 'application/json' });
        res.end(rejected.errorBody ?? '');
        return void resolveDone();
      }
      fail(noAnswerMessage('No model could answer.'));
    };

    const win = async (attempt: Attempt) => {
      if (settled) return;
      settle();
      this.health.markOk(attempt.model);
      for (const other of attempts) {
        if (other === attempt) continue;
        other.controller.abort();
        // The model we left behind never produced anything; steer around it for a while.
        if (other.model === primary) this.health.markBusy(primary);
      }
      this.config.onAnswered?.(attempt.model === primary ? { requested: primary, model: primary } : { requested: primary, model: attempt.model, reason: backupReason });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const chunk of attempt.buffered) res.write(chunk);
      attempt.buffered = [];
      try {
        while (true) {
          const { value, done: finished } = await attempt.reader!.read();
          if (finished) break;
          res.write(value);
        }
      } catch {
        // aborted or upstream closed; end what we have
      }
      res.end();
      resolveDone();
    };

    const run = async (model: string) => {
      const attempt: Attempt = { model, controller: new AbortController(), buffered: [] };
      attempts.push(attempt);
      try {
        const response = await fetch(target, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...request, model }),
          signal: attempt.controller.signal,
        });
        if (!response.ok || !response.body) {
          attempt.status = response.status;
          attempt.errorBody = await response.text();
          return attemptFailed(attempt);
        }
        attempt.reader = response.body.getReader();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        while (!settled) {
          const { value, done: finished } = await attempt.reader.read();
          if (finished) {
            // The stream ended without any model output: count it as a failed attempt.
            attempt.status = 502;
            attempt.errorBody = Buffer.concat(attempt.buffered).toString('utf8') || undefined;
            return attemptFailed(attempt);
          }
          attempt.buffered.push(value);
          if (parser.push(decoder.decode(value, { stream: true })).some((event) => isModelOutput(event.event))) {
            return void win(attempt);
          }
        }
      } catch (error) {
        if (attempt.controller.signal.aborted) return;
        attempt.status = 502;
        attempt.errorBody = JSON.stringify({ error: { message: (error as Error).message } });
        attemptFailed(attempt);
      }
    };

    const startBackup = (reason: string, past: StandInReason) => {
      if (backupStarted || settled || !backupModel) return;
      backupStarted = true;
      backupReason = past;
      this.config.onStatus(`${shortModelName(primary)} ${reason}. Asked ${shortModelName(backupModel)} too.`);
      void run(backupModel);
    };

    const stallMs = this.config.stallMs ?? STALL_MS;
    const giveUpMs = this.config.giveUpMs ?? GIVE_UP_MS;
    const startPrimary = () => {
      if (primaryStarted || settled) return;
      primaryStarted = true;
      void run(primary);
    };
    if (this.health.isBusy(primary) && backupModel) {
      // It failed in the last few minutes: go straight to the backup and leave the provider's slots free.
      // The model gets another chance if the backup fails or stalls, and once its busy mark expires.
      backupStarted = true;
      backupReason = 'busy';
      void run(backupModel);
      timers.push(setTimeout(startPrimary, stallMs));
    } else {
      startPrimary();
    }
    if (this.config.enabled()) timers.push(setTimeout(() => startBackup('is slow right now', 'slow'), Math.min(this.config.delayMs(), stallMs)));
    timers.push(setTimeout(() => startBackup(`hasn't answered in ${Math.round(stallMs / 1000)}s`, 'not answering'), stallMs));
    timers.push(
      setTimeout(() => {
        for (const attempt of attempts) this.health.markBusy(attempt.model);
        fail(noAnswerMessage(`No answer after ${Math.round(giveUpMs / 1000)}s.`));
      }, giveUpMs),
    );
    await done;
  }
}
