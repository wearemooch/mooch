// Caps how much command output reaches the UI. A recursive grep over binary files once streamed
// megabytes per second into the transcript and took the window down with it. The model's own view
// of the output is capped separately by Codex.

export const OUTPUT_LIMIT = 64 * 1024;

export function truncatedNote(limit = OUTPUT_LIMIT): string {
  return `\n… output truncated: only the first ${Math.round(limit / 1024)} KB are shown.\n`;
}

export class OutputLimiter {
  private readonly sizes = new Map<string, number>();

  constructor(private readonly limit = OUTPUT_LIMIT) {}

  /** The part of `delta` to show, or null once the item has hit the limit. */
  delta(itemId: string, delta: string): string | null {
    const used = this.sizes.get(itemId) ?? 0;
    if (used > this.limit) return null;
    const room = this.limit - used;
    if (delta.length <= room) {
      this.sizes.set(itemId, used + delta.length);
      return delta;
    }
    this.sizes.set(itemId, this.limit + 1);
    return delta.slice(0, room) + truncatedNote(this.limit);
  }

  /** A command's final aggregated output, cut the same way. */
  whole(itemId: string, output: string): string {
    if (output.length <= this.limit) return output;
    this.sizes.set(itemId, this.limit + 1);
    return output.slice(0, this.limit) + truncatedNote(this.limit);
  }
}
