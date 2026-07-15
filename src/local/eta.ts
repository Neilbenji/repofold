// Rough ETA tracking for the deep pipeline: EWMA of call latency per pass,
// seeded from the previous run so the pre-run estimate is meaningful.
export class EtaTracker {
  private avgMs: Record<string, number>;
  private planned: Record<string, number> = {};
  private done: Record<string, number> = {};

  constructor(seed: Record<string, number> | undefined, private defaultMs = 20_000) {
    this.avgMs = { ...(seed ?? {}) };
  }

  begin(pass: string, totalCalls: number): void {
    this.planned[pass] = totalCalls;
    this.done[pass] = 0;
  }

  record(pass: string, latencyMs: number): void {
    this.done[pass] = (this.done[pass] ?? 0) + 1;
    const previous = this.avgMs[pass] ?? latencyMs;
    this.avgMs[pass] = Math.round(previous * 0.7 + latencyMs * 0.3);
  }

  /** Estimated minutes for `calls` calls of a pass at current concurrency. */
  estimateMinutes(pass: string, calls: number, concurrency: number): number {
    const per = this.avgMs[pass] ?? this.defaultMs;
    return Math.ceil((calls * per) / Math.max(1, concurrency) / 60_000);
  }

  remaining(pass: string, concurrency: number): string {
    const left = (this.planned[pass] ?? 0) - (this.done[pass] ?? 0);
    if (left <= 0) return "";
    const minutes = this.estimateMinutes(pass, left, concurrency);
    return minutes >= 1 ? `~${minutes}m left` : "<1m left";
  }

  snapshot(): Record<string, number> {
    return { ...this.avgMs };
  }
}
