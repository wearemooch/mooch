// Incremental Server-Sent Events parser for FCC's streaming /v1/responses.

export interface SseEvent {
  event: string;
  data: string;
  /** The exact bytes of this event as received, for proxies that pass events through. */
  raw: string;
}

export class SseParser {
  private buffer = '';

  /** Feed a chunk; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: SseEvent[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length || event !== 'message') events.push({ event, data: data.join('\n'), raw: `${block}\n\n` });
    }
    return events;
  }
}

/** Events that mean the model is actually producing output (not just "request accepted"). */
export function isModelOutput(event: string): boolean {
  return event.endsWith('.delta') || event === 'response.completed' || event === 'response.output_item.done';
}
