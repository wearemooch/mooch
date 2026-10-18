// Newline-delimited JSON-RPC (Codex app-server wire format: JSON-RPC 2.0 without the "jsonrpc" field).
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export type RequestId = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcRequestError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: RpcError,
  ) {
    super(`${method} failed: ${rpcError.message}`);
  }
}

export class ConnectionClosedError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export interface IncomingRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

/**
 * Events:
 * - 'notification' (method: string, params: unknown)
 * - 'request' (request: IncomingRequest) — server-to-client requests such as approvals
 * - 'close' (reason: string)
 */
export class JsonlRpcConnection extends EventEmitter {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private closedReason: string | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly idPrefix = 'fc',
  ) {
    super();
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    input.on('end', () => this.close('The agent process closed its output.'));
    input.on('error', (error) => this.close(`The agent connection failed: ${error.message}`));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closedReason !== null) {
      return Promise.reject(new ConnectionClosedError(this.closedReason));
    }
    const id = `${this.idPrefix}-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, error: RpcError): void {
    this.write({ id, error });
  }

  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new ConnectionClosedError(reason));
      this.pending.delete(id);
    }
    this.emit('close', reason);
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedReason !== null) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const frame = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (frame) this.onFrame(frame);
    }
  }

  private onFrame(frame: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      this.emit('protocolError', `Unparseable frame: ${frame.slice(0, 200)}`);
      return;
    }
    const id = message.id as RequestId | undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;

    if (method !== undefined && id !== undefined) {
      this.emit('request', { id, method, params: message.params } satisfies IncomingRequest);
    } else if (method !== undefined) {
      this.emit('notification', method, message.params);
    } else if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcRequestError(pending.method, message.error as RpcError));
      else pending.resolve(message.result);
    }
  }
}
