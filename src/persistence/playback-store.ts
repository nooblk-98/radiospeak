import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PlaybackSnapshot } from "../audio/player.ts";

/** Kept separate from the library so progress checkpoints never reload idle playlists. */
export class PlaybackStore {
  #path: string;
  #bots: Record<string, PlaybackSnapshot> = {};
  #report: (message: string) => void;
  #writeFailed = false;
  #pending = false;
  #timer: NodeJS.Timeout | undefined;
  #writing: Promise<void> | undefined;
  lastSavedAt: string | null = null;
  get status() {
    return {
      pending: this.#pending || !!this.#writing,
      error: this.#writeFailed,
      lastSavedAt: this.lastSavedAt,
    };
  }

  constructor(
    path = resolve(process.env.FMBOT_PLAYBACK ?? "playback.json"),
    report = console.warn,
  ) {
    this.#path = path;
    this.#report = report;
    try {
      if (!existsSync(path)) return;
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (
        data?.version !== 1 ||
        !data.bots ||
        typeof data.bots !== "object" ||
        Array.isArray(data.bots)
      )
        throw new Error("Invalid checkpoint file");
      this.#bots = data.bots;
    } catch (err) {
      report(
        "Could not read playback checkpoints: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  get(bot: string): PlaybackSnapshot | undefined {
    return this.#bots[bot];
  }

  delete(bot: string): void {
    delete this.#bots[bot];
    this.#pending = true;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, 50).unref();
  }

  set(bot: string, snapshot: PlaybackSnapshot): void {
    this.#bots[bot] = snapshot;
    this.#pending = true;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, 50).unref();
  }

  /** Coalesced, serialized atomic writes; shutdown awaits the latest generation. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#writing) return this.#writing;
    this.#writing = this.#drain().finally(() => {
      this.#writing = undefined;
    });
    return this.#writing;
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      this.#pending = false;
      const content = JSON.stringify({ version: 1, bots: this.#bots }) + "\n";
      try {
        await writeFile(this.#path + ".tmp", content);
        await rename(this.#path + ".tmp", this.#path);
        this.#writeFailed = false;
        this.lastSavedAt = new Date().toISOString();
      } catch (err) {
        if (!this.#writeFailed)
          this.#report(
            "Could not save playback checkpoints: " +
              (err instanceof Error ? err.message : String(err)),
          );
        this.#writeFailed = true;
      }
    }
  }
}
