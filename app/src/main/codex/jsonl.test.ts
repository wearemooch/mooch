import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConnectionClosedError, JsonlRpcConnection, RpcRequestError, type IncomingRequest } from './jsonl';

function setup() {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  let partial = '';
  toServer.setEncoding('utf8');
  toServer.on('data', (chunk: string) => {
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line) sent.push(JSON.parse(line));
  });
  const connection = new JsonlRpcConnection(fromServer, toServer, 't');
  const serverSend = (message: unknown) => fromServer.write(`${JSON.stringify(message)}\n`);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { connection, sent, serverSend, fromServer, flush };
}

describe('JsonlRpcConnection', () => {
  it('correlates responses to requests by id', async () => {
    const { connection, sent, serverSend, flush } = setup();
    const result = connection.request('thread/start', { cwd: '/w' });
    await flush();
    expect(sent[0]).toEqual({ id: 't-1', method: 'thread/start', params: { cwd: '/w' } });
    serverSend({ id: 't-1', result: { thread: { id: 'th1' } } });
    await expect(result).resolves.toEqual({ thread: { id: 'th1' } });
  });

  it('rejects with the server error', async () => {
    const { connection, serverSend } = setup();
    const result = connection.request('turn/start', {});
    serverSend({ id: 't-1', error: { code: -32600, message: 'bad' } });
    await expect(result).rejects.toBeInstanceOf(RpcRequestError);
  });

  it('splits frames across chunk boundaries and emits notifications', async () => {
    const { connection, fromServer, flush } = setup();
    const seen: [string, unknown][] = [];
    connection.on('notification', (method: string, params: unknown) => seen.push([method, params]));
    const frame = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hi' } });
    fromServer.write(frame.slice(0, 10));
    fromServer.write(`${frame.slice(10)}\n${JSON.stringify({ method: 'turn/started', params: {} })}\n`);
    await flush();
    expect(seen).toEqual([
      ['item/agentMessage/delta', { delta: 'hi' }],
      ['turn/started', {}],
    ]);
  });

  it('surfaces server requests and sends responses back', async () => {
    const { connection, sent, serverSend, flush } = setup();
    const requests: IncomingRequest[] = [];
    connection.on('request', (request: IncomingRequest) => requests.push(request));
    serverSend({ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'i1' } });
    await flush();
    expect(requests).toEqual([{ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'i1' } }]);
    connection.respond(7, { decision: 'accept' });
    await flush();
    expect(sent.at(-1)).toEqual({ id: 7, result: { decision: 'accept' } });
  });

  it('rejects pending requests when the stream ends', async () => {
    const { connection, fromServer } = setup();
    const result = connection.request('initialize', {});
    fromServer.end();
    await expect(result).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(connection.request('x', {})).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});
