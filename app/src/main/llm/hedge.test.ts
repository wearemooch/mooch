import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HedgeProxy, rejectReason, type Answer, type HedgeConfig, type Unavailable } from './hedge';
import { ModelHealth } from './modelHealth';

// Fake FCC: "fast" streams at once, "slow" waits, "bad" fails, "busy" is overloaded (529),
// "reject" refuses the request (400), "silent" ends without output, "hang" never answers.
const calls: string[] = [];
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const { model } = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(model);
  const status = { bad: 500, busy: 529, reject: 400 }[model as string];
  if (status) {
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `${model} says no` } }));
  }
  if (model.startsWith('hang')) return; // the socket is closed when the proxy aborts
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: response.created\ndata: {}\n\n');
  if (model === 'silent') return res.end();
  if (model === 'slow') await new Promise((r) => setTimeout(r, 1500));
  res.write(`event: response.output_text.delta\ndata: {"delta":"from ${model}"}\n\n`);
  res.end('event: response.completed\ndata: {}\n\n');
});

let upstreamUrl = '';
const statuses: string[] = [];
const answers: Answer[] = [];
const failures: Unavailable[] = [];
const proxies: HedgeProxy[] = [];

function makeProxy(overrides: Partial<HedgeConfig> = {}): HedgeProxy {
  const proxy = new HedgeProxy({
    upstream: () => ({ url: upstreamUrl, token: 'tok' }),
    backupsFor: (model) => [model === 'fast' ? 'slow' : 'fast'],
    enabled: () => true,
    delayMs: () => 200,
    onStatus: (m) => statuses.push(m),
    onAnswered: (a) => answers.push(a),
    onUnavailable: (f) => failures.push(f),
    ...overrides,
  });
  proxies.push(proxy);
  return proxy;
}

async function ask(proxy: HedgeProxy, model: string) {
  const response = await fetch(`${await proxy.start()}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model, input: 'x' }) });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterEach(() => {
  calls.length = 0;
  statuses.length = 0;
  answers.length = 0;
  failures.length = 0;
});
afterAll(() => {
  proxies.forEach((p) => p.stop());
  upstream.closeAllConnections();
  upstream.close();
});

describe('HedgeProxy', () => {
  it('passes a fast primary through without a backup call', async () => {
    const result = await ask(makeProxy(), 'fast');
    expect(result.text).toContain('from fast');
    expect(result.text).toContain('response.created');
    expect(calls).toEqual(['fast']);
  });

  it('lets the backup win when the primary is slow', async () => {
    const result = await ask(makeProxy(), 'slow');
    expect(result.text).toContain('from fast');
    expect(result.text).not.toContain('from slow');
    expect(calls).toEqual(['slow', 'fast']);
    expect(statuses.join(' ')).toMatch(/slow is slow right now. Asked fast too/);
    // Merely slow: the backup answered this once, which is not a reason to switch the chat.
    expect(answers).toEqual([{ requested: 'slow', model: 'fast', reason: 'slow' }]);
  });

  it('starts the backup at once when the primary fails, is overloaded or goes silent', async () => {
    for (const primary of ['bad', 'busy', 'silent']) {
      calls.length = 0;
      const result = await ask(makeProxy(), primary);
      expect(result.status).toBe(200);
      expect(result.text).toContain('from fast');
      expect(calls).toEqual([primary, 'fast']);
    }
    expect(statuses.join(' ')).toMatch(/busy is overloaded right now/);
    // Overloaded (its limit) and failing are the reasons the chat moves to the backup.
    expect(answers.map((a) => a.reason)).toEqual(['failing', 'overloaded', 'failing']);
  });

  it('with hedging off, waits for a slow model instead of asking the backup', async () => {
    const result = await ask(makeProxy({ enabled: () => false, stallMs: 5000 }), 'slow');
    expect(result.text).toContain('from slow');
    expect(calls).toEqual(['slow']);
  });

  it('with hedging off, still fails over when the model fails or stalls', async () => {
    const proxy = makeProxy({ enabled: () => false, stallMs: 200 });
    expect((await ask(proxy, 'busy')).text).toContain('from fast');
    expect((await ask(proxy, 'hang')).text).toContain('from fast');
    expect(statuses.join(' ')).toMatch(/hang hasn't answered in 0s/);
  });

  it('skips a model that was busy a moment ago and asks only its backup', async () => {
    const health = new ModelHealth();
    const proxy = makeProxy({ enabled: () => false, stallMs: 5000, health });
    await ask(proxy, 'busy');
    expect(health.isBusy('busy')).toBe(true);
    expect(health.isBusy('fast')).toBe(false);
    calls.length = 0;
    statuses.length = 0;
    answers.length = 0;
    expect((await ask(proxy, 'busy')).text).toContain('from fast');
    expect(calls).toEqual(['fast']);
    expect(answers).toEqual([{ requested: 'busy', model: 'fast', reason: 'busy' }]);
  });

  it('gives a skipped busy model another try when its backup fails', async () => {
    const health = new ModelHealth();
    health.markBusy('fast');
    const result = await ask(makeProxy({ backupsFor: () => ['bad'], health }), 'fast');
    expect(result.text).toContain('from fast');
    expect(calls).toEqual(['bad', 'fast']);
    expect(health.isBusy('fast')).toBe(false);
  });

  it('skips a busy backup for the next stand-in', async () => {
    const health = new ModelHealth();
    health.markBusy('bad');
    const result = await ask(makeProxy({ backupsFor: () => ['bad', 'fast'], health }), 'busy');
    expect(result.text).toContain('from fast');
    expect(calls).toEqual(['busy', 'fast']);
  });

  it('gives up with a plain message when no model answers', async () => {
    const health = new ModelHealth();
    const result = await ask(makeProxy({ backupsFor: () => ['hang2'], stallMs: 100, giveUpMs: 400, health }), 'hang');
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).error.message).toMatch(/No answer after 0s\. hang and hang2 are probably overloaded/);
    expect(health.isBusy('hang')).toBe(true);
    expect(failures).toEqual([{ requested: 'hang', tried: ['hang', 'hang2'], why: 'silent' }]);
  });

  it('fails fast with a plain message when the only model is overloaded', async () => {
    const result = await ask(makeProxy({ backupsFor: () => [] }), 'busy');
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text).error.message).toMatch(/No model could answer\. busy is probably overloaded/);
    // With no backup (Backup off), the chat says the model hit its limit and offers what to do.
    expect(failures).toEqual([{ requested: 'busy', tried: ['busy'], why: 'limit' }]);
    expect(answers).toEqual([]);
  });

  it('reports a failing model as failed, not as a limit', async () => {
    await ask(makeProxy({ backupsFor: () => [] }), 'bad');
    expect(failures).toEqual([{ requested: 'bad', tried: ['bad'], why: 'failed' }]);
  });

  it('passes a rejected request through unchanged when the backup fails too', async () => {
    const health = new ModelHealth();
    const result = await ask(makeProxy({ backupsFor: () => ['bad'], health }), 'reject');
    expect(result.status).toBe(400);
    expect(result.text).toContain('reject says no');
    expect(health.isBusy('reject')).toBe(false);
  });
});

describe('ModelHealth', () => {
  it('forgets a failure after a few minutes and reports changes', () => {
    let now = 0;
    const seen: Record<string, number>[] = [];
    const health = new ModelHealth((busy) => seen.push(busy), () => now);
    health.markBusy('a');
    expect(health.pick(['a', 'b'])).toBe('b');
    expect(seen.at(-1)).toEqual({ a: 180_000 });
    now = 180_001;
    expect(health.isBusy('a')).toBe(false);
    expect(health.pick(['a', 'b'])).toBe('a');
    health.markBusy('b');
    health.markOk('b');
    expect(seen.at(-1)).toEqual({});
  });
});

describe('rejectReason', () => {
  const ok = { url: '/v1/responses', headers: { host: '127.0.0.1:5000', authorization: 'Bearer tok' } };
  it('serves Codex model calls only', () => {
    expect(rejectReason(ok, 'tok')).toBeUndefined();
    expect(rejectReason({ ...ok, url: '/admin/api/config' }, 'tok')).toBe('not found');
    expect(rejectReason({ ...ok, headers: { ...ok.headers, authorization: 'Bearer nope' } }, 'tok')).toBe('unauthorized');
    expect(rejectReason({ ...ok, headers: { ...ok.headers, host: 'evil.example:5000' } }, 'tok')).toBe('bad host');
    expect(rejectReason({ ...ok, headers: { ...ok.headers, origin: 'http://127.0.0.1:5000' } }, 'tok')).toMatch(/cross-origin/);
  });
});
