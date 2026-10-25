import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PLAYLISTS_PATH } from "./config.ts";
import type { Track } from "./player.ts";

export interface SavedPlaylist {
  name: string;
  tracks: Track[];
}

/** Named playlists people build from chat or the web panel, kept in playlists.json. */
export class PlaylistStore {
  #path: string;
  #lists: SavedPlaylist[];

  constructor(path = PLAYLISTS_PATH) {
    this.#path = path;
    const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SavedPlaylist[]) : [];
    this.#lists = raw.filter((p) => p && p.name && Array.isArray(p.tracks));
  }

  get all(): readonly SavedPlaylist[] {
    return this.#lists;
  }

  /** By list number (1-based) or name, ignoring case. */
  find(query: string): SavedPlaylist | undefined {
    const q = query.trim().toLowerCase();
    const n = Number(q);
    if (Number.isInteger(n) && n >= 1 && n <= this.#lists.length) return this.#lists[n - 1];
    return this.#lists.find((p) => p.name.toLowerCase() === q);
  }

  create(name: string): SavedPlaylist {
    // One word, so chat commands like "!pl add <name> <link>" stay unambiguous.
    const clean = name.trim().replace(/\s+/g, "-").slice(0, 40);
    if (!clean || /^\d+$/.test(clean)) throw new Error("Give the playlist a name (not just a number)");
    if (this.find(clean)) throw new Error(`A playlist called "${clean}" already exists`);
    const list: SavedPlaylist = { name: clean, tracks: [] };
    this.#lists.push(list);
    this.#save();
    return list;
  }

  addTracks(list: SavedPlaylist, tracks: Track[]): number {
    // Only what is worth keeping: no requester, no default-playlist marker.
    list.tracks.push(...tracks.map((t) => ({ url: t.url, title: t.title, ...(t.duration ? { duration: t.duration } : {}) })));
    this.#save();
    return list.tracks.length;
  }

  removeTrack(list: SavedPlaylist, position: number): Track | undefined {
    const [removed] = list.tracks.splice(position - 1, 1);
    if (removed) this.#save();
    return removed;
  }

  delete(list: SavedPlaylist): void {
    this.#lists = this.#lists.filter((p) => p !== list);
    this.#save();
  }

  #save(): void {
    writeFileSync(this.#path, JSON.stringify(this.#lists, null, 2) + "\n");
  }
}
