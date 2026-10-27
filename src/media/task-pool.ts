/** A bounded FIFO for expensive child processes. Queued cancellations cost no slot. */
export class TaskPool {
  #active = 0;
  #waiting: Array<() => void> = [];
  readonly limit: number;
  constructor(limit = 2) {
    this.limit = limit;
  }
  get stats() {
    return { active: this.#active, queued: this.#waiting.length, limit: this.limit };
  }
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#waiting.length >= 20)
      throw new Error("Media service is busy. Please try again shortly.");
    await new Promise<void>((accept, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.#active++;
        accept();
      };
      const cancel = () => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal?.reason ?? new Error("Cancelled"));
      };
      if (this.#active < this.limit) start();
      else {
        this.#waiting.push(start);
        signal?.addEventListener("abort", cancel, { once: true });
      }
    });
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}
