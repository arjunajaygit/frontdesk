import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Errors } from './app-error';

/** Hard bound on tracked keys: a spray of distinct keys (IPs, users) can never grow memory without limit. */
export const MAX_LIMITER_KEYS = 100_000;

/**
 * In-process fixed-window limiter (single instance). A multi-instance deployment needs a shared store
 * (roadmap P1); the DB-level invariants never depend on this limiter. Memory is bounded: expired windows are
 * pruned every minute and, at MAX_LIMITER_KEYS, the oldest window is evicted (fails open for that one key,
 * never for the caller being counted).
 */
@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper = setInterval(() => this.prune(), 60_000).unref();

  /** Overridable in tests only (subclass); production uses MAX_LIMITER_KEYS. */
  protected readonly maxKeys: number = MAX_LIMITER_KEYS;

  size(): number {
    return this.windows.size;
  }

  consume(key: string, limit: number, windowMs = 60_000): void {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (w) this.windows.delete(key); // re-insert so Map order tracks recency of the window
      if (this.windows.size >= this.maxKeys) {
        this.prune();
        while (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value as string);
      }
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (++w.count > limit) throw Errors.tooMany();
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }
}
