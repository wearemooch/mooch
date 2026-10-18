import { describe, expect, it } from 'vitest';
import { readableError } from './appServer';

describe('readableError', () => {
  it('pulls the message out of a gateway JSON body', () => {
    expect(readableError('{"error":{"type":"model_unavailable","message":"No answer after 150s."}}')).toBe('No answer after 150s.');
    expect(readableError('unexpected status 529 Service Overloaded: {"error":{"message":"Provider is overloaded"}}')).toBe('Provider is overloaded');
    expect(readableError('unexpected status 422: {"detail":"bad input"}')).toBe('bad input');
  });

  it('leaves other messages alone', () => {
    expect(readableError('stream disconnected before completion')).toBe('stream disconnected before completion');
    expect(readableError('weird {not json')).toBe('weird {not json');
    expect(readableError('{"error":{}}')).toBe('{"error":{}}');
  });
});
