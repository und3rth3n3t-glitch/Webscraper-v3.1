import { MessageType } from '../../types/messages';
import { swLog } from '../../utils/swLog';

export interface PreflightTimerOptions {
  taskId: string;
  durationMs: number;
  // Injected so tests can capture emissions without runtime stubs.
  // In production wraps `browser.runtime.sendMessage(...).catch(() => {})`.
  emit: (msg: { type: typeof MessageType.FLOW_PREFLIGHT_READY; payload: { taskId: string } }) => void;
}

// One-shot quiet-window timer. Lifecycle:
//   arm()    → start countdown (or restart if already pending)
//   cancel() → stop without emitting (called when a detector fires)
//   force()  → emit immediately (manual override)
// Once `emit` has fired (timer-elapsed or force), all subsequent calls
// are no-ops. Designed for one PreflightTimer per executeFlow() invocation.
export class PreflightTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private emitted = false;

  constructor(private readonly opts: PreflightTimerOptions) {}

  get taskId(): string {
    return this.opts.taskId;
  }

  isReady(): boolean {
    return this.emitted;
  }

  isPending(): boolean {
    return this.handle !== null && !this.emitted;
  }

  // Start (or restart) the countdown. No-op once emitted.
  arm(): void {
    if (this.emitted) return;
    this.cancel();
    this.handle = setTimeout(() => {
      this.handle = null;
      if (this.emitted) return;
      this.emitted = true;
      swLog('[preflightTimer] elapsed → FLOW_PREFLIGHT_READY | taskId:', this.opts.taskId);
      this.opts.emit({
        type: MessageType.FLOW_PREFLIGHT_READY,
        payload: { taskId: this.opts.taskId },
      });
    }, this.opts.durationMs);
  }

  // Cancel any pending countdown without emitting. Idempotent.
  cancel(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  // Emit immediately, regardless of remaining time. One-shot.
  force(): void {
    if (this.emitted) return;
    this.cancel();
    this.emitted = true;
    swLog('[preflightTimer] FORCED → FLOW_PREFLIGHT_READY | taskId:', this.opts.taskId);
    this.opts.emit({
      type: MessageType.FLOW_PREFLIGHT_READY,
      payload: { taskId: this.opts.taskId },
    });
  }
}
