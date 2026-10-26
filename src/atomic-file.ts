import { writeFile, rename } from "node:fs/promises";

/** Coalesced, ordered writes. Acknowledged mutations can await flush for durability. */
export class AtomicFile {
  #path: string;
  #content: () => string;
  #dirty = false;
  #timer?: NodeJS.Timeout;
  #writing?: Promise<void>;
  error: string | null = null;
  constructor(path: string, content: () => string) { this.#path = path; this.#content = content; }
  schedule() {
    this.#dirty = true;
    this.#timer ??= setTimeout(() => { this.#timer = undefined; void this.flush().catch(() => {}); }, 40).unref();
  }
  async flush(): Promise<void> {
    clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#writing) { await this.#writing; if (this.#dirty) return this.flush(); return; }
    this.#writing = (async () => {
      while (this.#dirty) {
        this.#dirty = false;
        try {
          const content = this.#content();
          await writeFile(this.#path + ".tmp", content, { mode: 0o600 });
          await rename(this.#path + ".tmp", this.#path);
          this.error = null;
        } catch (error) {
          this.#dirty = true;
          this.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
    })().finally(() => { this.#writing = undefined; });
    await this.#writing;
  }
}
