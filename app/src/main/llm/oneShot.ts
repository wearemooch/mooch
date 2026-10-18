// One request, one answer: used for planners, the judge and the reviewer (no tools, no agent loop).
import { SseParser } from './sse';

export interface OneShotOptions {
  fccUrl: string;
  token: string;
  model: string;
  instructions: string;
  input: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export class OneShotError extends Error {}

/** Shortens FCC's multi-line upstream errors to their first meaningful line. */
export function summarizeError(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; detail?: string };
    message = parsed.error?.message ?? parsed.detail ?? body;
  } catch {
    // not JSON
  }
  return `HTTP ${status}: ${message.split('\n')[0].slice(0, 200)}`;
}

export async function oneShot(options: OneShotOptions): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${options.fccUrl}/v1/responses`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: options.input }] }],
        max_output_tokens: options.maxOutputTokens ?? 4000,
      }),
    });
  } catch (error) {
    throw new OneShotError(timeout.aborted ? 'timed out' : (error as Error).message);
  }
  if (!response.ok || !response.body) throw new OneShotError(summarizeError(response.status, await response.text()));

  const parser = new SseParser();
  const decoder = new TextDecoder();
  let text = '';
  let completedText: string | undefined;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (event.event === 'response.output_text.delta') {
          text += (JSON.parse(event.data) as { delta: string }).delta;
        } else if (event.event === 'response.completed') {
          const output = (JSON.parse(event.data) as { response?: { output?: { type: string; content?: { type: string; text?: string }[] }[] } })
            .response?.output;
          completedText = output
            ?.filter((item) => item.type === 'message')
            .flatMap((item) => item.content ?? [])
            .map((part) => part.text ?? '')
            .join('');
        } else if (event.event === 'response.failed' || event.event === 'error') {
          throw new OneShotError(event.data.slice(0, 200));
        }
      }
    }
  } catch (error) {
    if (error instanceof OneShotError) throw error;
    throw new OneShotError(timeout.aborted ? 'timed out' : (error as Error).message);
  }
  const result = (completedText || text).trim();
  if (!result) throw new OneShotError('the model returned an empty answer');
  return result;
}
