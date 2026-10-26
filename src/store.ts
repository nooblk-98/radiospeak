import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PLAYLISTS_PATH, validateNickname } from "./config.ts";
import type { Track } from "./player.ts";
import { trackKey } from "./track-key.ts";

export interface SavedPlaylist {
  id: string;
  name: string;
  collectionId: string | null;
  tracks: Track[];
  version: string;
}
export interface Collection { id: string; name: string }
export interface RadioStation { id: string; name: string; url: string }
interface Library {
  version: 2;
  playlists: SavedPlaylist[];
  collections: Collection[];
  defaults: Record<string, string | null>;
  favorites: Track[];
  botNicknames: Record<string, string>;
  /** Channel path ("Parent/Child") each bot joins on connect, chosen in the web panel. */
  botChannels: Record<string, string>;
  radioStations: RadioStation[];
  /** Bot instances added in the web panel, started alongside the configured ones. */
  panelBots: string[];
  /** Bots that do not greet people joining their channel (greeting is on by default). */
  quietBots: string[];
}

/** Offered until the library has its own station list. */
const starterStations: Omit<RadioStation, "id">[] = [
  { name: "Groove Salad", url: "https://ice5.somafm.com/groovesalad-128-mp3" },
  { name: "Drone Zone", url: "https://ice5.somafm.com/dronezone-128-mp3" },
];

/** Accepts legacy playlist arrays; writes the versioned library atomically. */
export class PlaylistStore {
  #path: string;
  #data: Library;
  onChange?: () => void;

  constructor(path = PLAYLISTS_PATH) {
    this.#path = path;
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    const lists = Array.isArray(raw) ? raw : raw.playlists ?? [];
    this.#data = {
      version: 2,
      playlists: lists.filter((p: SavedPlaylist) => p && p.name && Array.isArray(p.tracks))
        .map((p: SavedPlaylist) => ({ ...p, id: p.id || randomUUID(), version: p.version || randomUUID(), collectionId: p.collectionId ?? null })),
      collections: Array.isArray(raw.collections) ? raw.collections : [],
      defaults: raw.defaults ?? {},
      favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      botNicknames: raw.botNicknames ?? {},
      botChannels: raw.botChannels ?? {},
      radioStations: Array.isArray(raw.radioStations)
        ? raw.radioStations.filter((r: RadioStation) => r && r.id && r.name && r.url)
        : starterStations.map((r) => ({ id: randomUUID(), ...r })),
      panelBots: Array.isArray(raw.panelBots) ? raw.panelBots.filter((n: unknown) => typeof n === "string" && n) : [],
      quietBots: Array.isArray(raw.quietBots) ? raw.quietBots.filter((n: unknown) => typeof n === "string") : [],
    };
  }

  get all(): readonly SavedPlaylist[] { return this.#data.playlists; }
  get collections(): readonly Collection[] { return this.#data.collections; }
  get favorites(): readonly Track[] { return this.#data.favorites; }
  get radioStations(): readonly RadioStation[] { return this.#data.radioStations; }
  get panelBots(): readonly string[] { return this.#data.panelBots; }

  /** Records a new panel instance with its name and optional home channel in one write. */
  addPanelBot(bot: string, nickname: string, channel?: string): void {
    this.#data.panelBots.push(bot);
    this.#data.botNicknames[bot] = validateNickname(nickname);
    if (channel) this.#data.botChannels[bot] = channel;
    this.#save();
  }

  /** Forgets a panel instance and its per-bot settings; its identity file is kept for reuse. */
  removePanelBot(bot: string): void {
    this.#data.panelBots = this.#data.panelBots.filter((n) => n !== bot);
    delete this.#data.botNicknames[bot];
    delete this.#data.botChannels[bot];
    delete this.#data.defaults[bot];
    this.#data.quietBots = this.#data.quietBots.filter((n) => n !== bot);
    this.#save();
  }
  get defaults(): Readonly<Record<string, string | null>> { return this.#data.defaults; }
  nicknameFor(bot: string): string | undefined { return this.#data.botNicknames[bot]; }
  setNickname(bot: string, nickname: string): void {
    this.#data.botNicknames[bot] = validateNickname(nickname);
    this.#save();
  }
  welcomes(bot: string): boolean { return !this.#data.quietBots.includes(bot); }
  setWelcomes(bot: string, enabled: boolean): void {
    this.#data.quietBots = this.#data.quietBots.filter((n) => n !== bot);
    if (!enabled) this.#data.quietBots.push(bot);
    this.#save();
  }
  channelFor(bot: string): string | undefined { return this.#data.botChannels[bot]; }
  setChannel(bot: string, path: string): void {
    this.#data.botChannels[bot] = path;
    this.#save();
  }
  hasDefault(bot: string): boolean { return Object.hasOwn(this.#data.defaults, bot); }
  defaultFor(bot: string): SavedPlaylist | undefined {
    const id = this.#data.defaults[bot];
    return id ? this.all.find((p) => p.id === id) : undefined;
  }

  /** By stable ID, list number (1-based), or case-insensitive name. */
  find(query: string): SavedPlaylist | undefined {
    const q = query.trim().toLowerCase();
    const n = Number(q);
    return this.all.find((p) => p.id === query || p.name.toLowerCase() === q)
      ?? (Number.isInteger(n) && n >= 1 ? this.all[n - 1] : undefined);
  }

  #name(name: string, others: readonly { name: string }[], current?: { name: string }): string {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!clean || /^\d+$/.test(clean)) throw new Error("Enter a name, not just a number");
    if (others.some((p) => p !== current && p.name.toLowerCase() === clean.toLowerCase())) throw new Error("That name is already in use");
    return clean;
  }

  create(name: string, collectionId: string | null = null): SavedPlaylist {
    this.#checkCollection(collectionId);
    const list: SavedPlaylist = { id: randomUUID(), version: randomUUID(), name: this.#name(name, this.all), collectionId, tracks: [] };
    this.#data.playlists.push(list);
    this.#save();
    return list;
  }

  update(list: SavedPlaylist, name: string, collectionId: string | null): void {
    this.#checkCollection(collectionId);
    list.name = this.#name(name, this.all, list);
    list.collectionId = collectionId;
    list.version = randomUUID();
    this.#save();
  }

  createCollection(name: string): Collection {
    const collection = { id: randomUUID(), name: this.#name(name, this.collections) };
    this.#data.collections.push(collection);
    this.#save();
    return collection;
  }

  renameCollection(id: string, name: string): void {
    const collection = this.#data.collections.find((c) => c.id === id);
    if (!collection) throw new Error("Collection not found");
    collection.name = this.#name(name, this.collections, collection);
    this.#save();
  }

  deleteCollection(id: string): void {
    this.#checkCollection(id);
    this.#data.collections = this.#data.collections.filter((c) => c.id !== id);
    this.all.forEach((p) => { if (p.collectionId === id) p.collectionId = null; });
    this.#save();
  }

  #checkCollection(id: string | null): void {
    if (id !== null && !this.collections.some((c) => c.id === id)) throw new Error("Collection not found");
  }

  /** By stable ID, list number (1-based), or case-insensitive name. */
  findStation(query: string): RadioStation | undefined {
    const q = query.trim().toLowerCase();
    const n = Number(q);
    return this.radioStations.find((r) => r.id === query || r.name.toLowerCase() === q)
      ?? (Number.isInteger(n) && n >= 1 ? this.radioStations[n - 1] : undefined);
  }

  createStation(name: string, url: string): RadioStation {
    const station = { id: randomUUID(), name: this.#name(name, this.radioStations), url };
    this.#data.radioStations.push(station);
    this.#save();
    return station;
  }

  updateStation(id: string, name: string, url: string): void {
    const station = this.#data.radioStations.find((r) => r.id === id);
    if (!station) throw new Error("Radio station not found");
    station.name = this.#name(name, this.radioStations, station);
    station.url = url;
    this.#save();
  }

  deleteStation(id: string): void {
    if (!this.radioStations.some((r) => r.id === id)) throw new Error("Radio station not found");
    this.#data.radioStations = this.#data.radioStations.filter((r) => r.id !== id);
    this.#save();
  }

  setDefault(bot: string, list: SavedPlaylist | null): void {
    if (list && !list.tracks.length) throw new Error("Add tracks before setting an idle playlist");
    this.#data.defaults[bot] = list?.id ?? null;
    this.#save();
  }

  toggleFavorite(track: Track): boolean {
    const index = this.#data.favorites.findIndex((t) => t.url === track.url);
    if (index < 0) this.#data.favorites.push(this.#cleanTrack(track));
    else this.#data.favorites.splice(index, 1);
    this.#save();
    return index < 0;
  }

  #cleanTrack(t: Track): Track {
    const { requestedBy, auto, ...saved } = t;
    return saved;
  }

  addTracks(list: SavedPlaylist, tracks: Track[]): number {
    list.tracks.push(...tracks.map((t) => this.#cleanTrack(t)));
    list.version = randomUUID();
    this.#save();
    return list.tracks.length;
  }

  removeTrack(list: SavedPlaylist, position: number): Track | undefined {
    if (!Number.isInteger(position) || position < 1 || position > list.tracks.length) return undefined;
    const [removed] = list.tracks.splice(position - 1, 1);
    list.version = randomUUID();
    this.#save();
    return removed;
  }

  moveTrack(list: SavedPlaylist, from: number, to: number): void {
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= list.tracks.length)) throw new Error("Invalid track position");
    list.tracks.splice(to - 1, 0, list.tracks.splice(from - 1, 1)[0]!);
    list.version = randomUUID();
    this.#save();
  }

  delete(list: SavedPlaylist): void {
    this.#data.playlists = this.#data.playlists.filter((p) => p !== list);
    for (const bot of Object.keys(this.#data.defaults)) {
      if (this.#data.defaults[bot] === list.id) this.#data.defaults[bot] = null;
    }
    this.#save();
  }

  addUniqueTracks(list: SavedPlaylist, tracks: Track[], skipDuplicates = true) {
    const seen = new Set(list.tracks.map(t => trackKey(t.url)));
    let duplicates = 0;
    const accepted = tracks.filter(t => {
      const key = trackKey(t.url);
      if (skipDuplicates && seen.has(key)) { duplicates++; return false; }
      seen.add(key); return true;
    });
    if (accepted.length) this.addTracks(list, accepted);
    return { added: accepted.length, duplicates };
  }

  #save(): void {
    writeFileSync(this.#path + ".tmp", JSON.stringify(this.#data, null, 2) + "\n");
    renameSync(this.#path + ".tmp", this.#path);
    this.onChange?.();
  }
}
