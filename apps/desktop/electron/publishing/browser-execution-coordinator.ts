import { PublishingError } from "./core";

interface Waiter {
  grant(): void;
  cancel(error: Error): void;
}

/** A visible account workspace retains its turn even while a menu obscures the view. */
export class BrowserExecutionCoordinator {
  private manual?: string;
  private busy = new Set<string>();
  private waiting = new Map<string, Waiter[]>();

  occupied(id: string) {
    return this.manual === id || this.busy.has(id);
  }

  setManual(id?: string) {
    const previous = this.manual;
    this.manual = id;
    if (previous && previous !== id) this.next(previous);
  }

  private next(id: string) {
    if (!this.occupied(id)) this.waiting.get(id)?.[0]?.grant();
  }

  async run<T>(
    id: string,
    foreground: boolean,
    work: () => Promise<T>,
    signal?: AbortSignal,
    waitMs = 30_000,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (foreground && this.busy.has(id))
      throw new PublishingError(
        "ACCOUNT_BUSY",
        "该账号浏览器正在执行任务，请稍后再试",
      );
    if (!foreground && this.occupied(id)) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting.get(id) ?? [];
        this.waiting.set(id, queue);
        const remove = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          queue.splice(queue.indexOf(waiter), 1);
          if (!queue.length) this.waiting.delete(id);
        };
        const waiter: Waiter = {
          grant: () => {
            remove();
            this.busy.add(id);
            resolve();
          },
          cancel: (error) => {
            remove();
            reject(error);
          },
        };
        const abort = () => waiter.cancel(signal!.reason);
        const timer = setTimeout(
          () =>
            waiter.cancel(
              new PublishingError(
                "BROWSER_TIMEOUT",
                "等待账号浏览器超时，请先退出人工浏览",
              ),
            ),
          waitMs,
        );
        queue.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else this.busy.add(id);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.busy.delete(id);
      this.next(id);
    }
  }

  reset() {
    for (const queue of this.waiting.values())
      for (const waiter of [...queue])
        waiter.cancel(new PublishingError("INTERRUPTED", "浏览器任务已中断"));
    this.manual = undefined;
  }
}
