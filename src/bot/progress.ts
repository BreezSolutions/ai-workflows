import type { WebClient } from "@slack/web-api";

export class ProgressTracker {
  private msgTs: string | null = null;
  private steps: string[] = [];
  private startedAt = Date.now();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updating = false;
  private dirty = false;
  private minInterval = 1500;

  constructor(
    private webClient: WebClient,
    private channel: string,
    private threadTs: string
  ) {}

  async start(): Promise<void> {
    const res = await this.webClient.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: ":hourglass_flowing_sand: *Thinking...*",
    });
    this.msgTs = res.ts ?? null;
    console.log(`[PROGRESS] Started, msgTs=${this.msgTs}`);
  }

  async addStep(step: string): Promise<void> {
    this.steps.push(step);
    console.log(`[PROGRESS] addStep(${this.steps.length}): ${step}`);
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    this.dirty = true;
    if (this.updateTimer || this.updating) return;
    // Fire immediately for the first update, then throttle
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.flush();
    }, this.steps.length === 1 ? 0 : this.minInterval);
  }

  private async flush(): Promise<void> {
    if (!this.msgTs || !this.dirty || this.updating) return;

    this.updating = true;
    this.dirty = false;

    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const visible = this.steps.slice(-8);
    const lines: string[] = [];

    if (this.steps.length > 8) {
      lines.push(`  _...and ${this.steps.length - 8} earlier steps_`);
    }
    for (let i = 0; i < visible.length; i++) {
      const icon = i < visible.length - 1 ? ":white_check_mark:" : ":gear:";
      lines.push(`  ${icon}  ${visible[i]}`);
    }

    const header = `:hourglass_flowing_sand: *Working* (${elapsed}s)`;
    const text = header + "\n" + lines.join("\n");

    try {
      await this.webClient.chat.update({
        channel: this.channel,
        ts: this.msgTs,
        text,
      });
      console.log(`[PROGRESS] Updated message (${this.steps.length} steps)`);
    } catch (err) {
      console.error(`[PROGRESS] Update failed:`, err);
    } finally {
      this.updating = false;
      if (this.dirty) {
        this.scheduleUpdate();
      }
    }
  }

  async finish(): Promise<void> {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (!this.msgTs) return;
    try {
      await this.webClient.chat.delete({
        channel: this.channel,
        ts: this.msgTs,
      });
    } catch {
      // best effort
    }
  }
}
