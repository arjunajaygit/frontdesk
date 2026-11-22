import { Injectable } from '@nestjs/common';

/**
 * Observer for transaction outcomes. Callbacks registered against a transaction client run only after that
 * transaction COMMITS; on rollback (or a retried attempt) they are discarded. Used so process-local metrics never
 * count business events that did not persist.
 */
@Injectable()
export class CommitHooks {
  private readonly pending = new WeakMap<object, Array<() => void>>();

  onCommit(tx: object, fn: () => void): void {
    const list = this.pending.get(tx);
    if (list) list.push(fn);
    else this.pending.set(tx, [fn]);
  }

  committed(tx: object | undefined): void {
    if (!tx) return;
    const list = this.pending.get(tx);
    this.pending.delete(tx);
    for (const fn of list ?? []) {
      try {
        fn();
      } catch {
        /* observers must never affect the committed business result */
      }
    }
  }

  discarded(tx: object | undefined): void {
    if (tx) this.pending.delete(tx);
  }
}
