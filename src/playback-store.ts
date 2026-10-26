import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlaybackSnapshot } from "./player.ts";

/** Kept separate from the library so progress checkpoints never reload idle playlists. */
export class PlaybackStore {
  #path: string;
  #bots: Record<string, PlaybackSnapshot> = {};
  #report: (message: string) => void;
  #writeFailed = false;

  constructor(path = resolve(process.env.FMBOT_PLAYBACK ?? "playback.json"), report = console.warn) {
    this.#path = path;
    this.#report = report;
    try {
      if (!existsSync(path)) return;
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data?.version !== 1 || !data.bots || typeof data.bots !== "object" || Array.isArray(data.bots)) throw new Error("Invalid checkpoint file");
      this.#bots = data.bots;
    } catch (err) {
      report("Could not read playback checkpoints: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  get(bot: string): PlaybackSnapshot | undefined { return this.#bots[bot]; }

  set(bot: string, snapshot: PlaybackSnapshot): void {
    this.#bots[bot] = snapshot;
    try {
      writeFileSync(this.#path + ".tmp", JSON.stringify({ version: 1, bots: this.#bots }) + "\n");
      renameSync(this.#path + ".tmp", this.#path);
      this.#writeFailed = false;
    } catch (err) {
      if (!this.#writeFailed) this.#report("Could not save playback checkpoints: " + (err instanceof Error ? err.message : String(err)));
      this.#writeFailed = true;
    }
  }
}
