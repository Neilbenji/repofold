// Plain-text progress for the terminal: stage lines with counters, per-page
// events, and a final summary. On a TTY the current line updates in place;
// on a non-TTY stream every event is its own line.
import type { Usage } from "./vendor/llm/client.js";

export class Progress {
  tokensIn = 0;
  tokensOut = 0;
  llmCalls = 0;
  private startedAt = Date.now();
  private lineOpen = false;

  usageSink = (usage: Usage): void => {
    this.tokensIn += usage.tokensIn;
    this.tokensOut += usage.tokensOut;
    this.llmCalls += 1;
  };

  private tty(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  private closeLine(): void {
    if (this.lineOpen) {
      process.stdout.write("\n");
      this.lineOpen = false;
    }
  }

  stage(step: number, total: number, message: string): void {
    this.closeLine();
    console.log(`[${step}/${total}] ${message}`);
  }

  /** Transient counter under the current stage, e.g. "batch 3/16". */
  tick(message: string): void {
    if (this.tty()) {
      process.stdout.write(`\r  ${message}\x1b[K`);
      this.lineOpen = true;
    } else {
      console.log(`  ${message}`);
    }
  }

  /** Permanent sub-line, e.g. per-page outcome. */
  line(message: string): void {
    this.closeLine();
    console.log(`  ${message}`);
  }

  warn(message: string): void {
    this.closeLine();
    console.warn(`  warning: ${message}`);
  }

  summary(counts: { generated: number; patched: number; remapped: number; skipped: number }, outDir: string): void {
    this.closeLine();
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    const wall = minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
    console.log("");
    console.log(
      `Done in ${wall}: ${counts.generated} generated, ${counts.patched} patched, ` +
        `${counts.remapped} remapped, ${counts.skipped} unchanged. ` +
        `${this.llmCalls} model calls, ${this.tokensIn.toLocaleString("en-US")} tokens in, ` +
        `${this.tokensOut.toLocaleString("en-US")} tokens out.`,
    );
    console.log(`Wiki written to ${outDir}`);
  }
}
