import { describe, expect, it } from 'vitest';
import { summarizeError } from './oneShot';
import { isModelOutput, SseParser } from './sse';

describe('SseParser', () => {
  it('parses events split across chunks and keeps raw bytes', () => {
    const parser = new SseParser();
    const first = parser.push('event: response.created\ndata: {"a":1}\n\nevent: response.output_text.de');
    expect(first).toEqual([{ event: 'response.created', data: '{"a":1}', raw: 'event: response.created\ndata: {"a":1}\n\n' }]);
    const second = parser.push('lta\r\ndata: {"delta":"hi"}\r\n\r\n: keepalive\n\n');
    expect(second.map((e) => [e.event, e.data])).toEqual([['response.output_text.delta', '{"delta":"hi"}']]);
  });

  it('tells real output from acknowledgements', () => {
    expect(isModelOutput('response.created')).toBe(false);
    expect(isModelOutput('response.in_progress')).toBe(false);
    expect(isModelOutput('response.reasoning_text.delta')).toBe(true);
    expect(isModelOutput('response.completed')).toBe(true);
  });

  it('shortens FCC upstream errors', () => {
    const body = JSON.stringify({ error: { message: 'Upstream provider NIM returned HTTP 404.\nCategory: upstream' } });
    expect(summarizeError(404, body)).toBe('HTTP 404: Upstream provider NIM returned HTTP 404.');
  });
});
