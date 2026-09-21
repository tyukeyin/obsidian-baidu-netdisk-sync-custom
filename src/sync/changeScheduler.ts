/** Coalesce changes without losing edits made during a running sync. */
export class ChangeScheduler {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private enabled: () => boolean,
    private busy: () => boolean,
    private run: () => Promise<{ success: boolean }>,
    private delay: () => number
  ) {}
  changed(): void {
    if (this.disposed || !this.enabled()) return;
    this.dirty = true;
    this.idle();
  }
  idle(): void {
    if (this.disposed || !this.dirty || !this.enabled() || this.busy()) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay());
  }
  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || !this.enabled() || this.busy()) return;
    this.dirty = false;
    try {
      const result = await this.run();
      if (!result.success) this.dirty = true;
    } catch {
      this.dirty = true;
    }
    // On failure retain the work for the next periodic/manual sync or edit;
    // do not retry in a tight loop against a rate-limited cloud service.
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
