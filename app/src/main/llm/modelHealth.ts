// Remembers which models failed or stalled recently, so the proxy can route around them
// and the model picker can say so. A model counts as busy for a few minutes after a failure.

const BUSY_FOR_MS = 3 * 60_000;

export class ModelHealth {
  private readonly busyUntil = new Map<string, number>();

  constructor(
    private readonly onChange: (busyUntil: Record<string, number>) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  markBusy(model: string): void {
    this.busyUntil.set(model, this.now() + BUSY_FOR_MS);
    this.changed();
  }

  markOk(model: string): void {
    if (this.busyUntil.delete(model)) this.changed();
  }

  isBusy(model: string): boolean {
    const until = this.busyUntil.get(model);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.busyUntil.delete(model);
    return false;
  }

  /** The first candidate that isn't busy, else the first candidate. */
  pick(candidates: string[]): string | undefined {
    return candidates.find((model) => !this.isBusy(model)) ?? candidates[0];
  }

  busy(): string[] {
    return [...this.busyUntil.keys()].filter((model) => this.isBusy(model));
  }

  private changed(): void {
    this.onChange(Object.fromEntries(this.busy().map((model) => [model, this.busyUntil.get(model)!])));
  }
}
