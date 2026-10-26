import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { AtomicFile } from "./atomic-file.ts";
import { settingsFrom, validateSchedule, type BotSettings, type PlaylistSchedule, type Role } from "./policies.ts";
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
export interface WebAccount { username: string; role: Role; salt: string; hash: string; version: string }
export interface HistoryEntry { id: string; track: Track; startedAt: string; endedAt: string | null; error: string | null }
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
  settings: Record<string, BotSettings>;
  schedules: PlaylistSchedule[];
  history: Record<string, HistoryEntry[]>;
  accounts: WebAccount[];
  chatAccess: { enabled: boolean; users: Record<string, Role>; groups: Record<string, Role> };
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
  #writer: AtomicFile;
  revision = 0;
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
      settings: raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? raw.settings : {},
      schedules: Array.isArray(raw.schedules) ? raw.schedules.filter((s: PlaylistSchedule) => {
        try { if (!s?.id || !s.bot || !s.playlistId) return false; validateSchedule(s); return true; } catch { return false; }
      }) : [],
      history: Object.fromEntries(Object.entries(raw.history ?? {}).filter(([,items]) => Array.isArray(items)).map(([bot,items]) => [bot,(items as HistoryEntry[]).filter(h => h?.track?.url && h.track.title && typeof h.startedAt === "string").slice(0,200)])),
      accounts: Array.isArray(raw.accounts) ? raw.accounts.filter((a: WebAccount) => a?.username && ["listener","dj","admin"].includes(a.role) && a.salt && a.hash && a.version) : [],
      chatAccess: raw.chatAccess && raw.chatAccess.users && raw.chatAccess.groups && typeof raw.chatAccess.users === "object" && typeof raw.chatAccess.groups === "object" ? raw.chatAccess : { enabled: false, users: {}, groups: {} },
    };
    this.#writer = new AtomicFile(path, () => JSON.stringify(this.#data, null, 2) + "\n");
  }

  flush() { return this.#writer.flush(); }
  get path() { return this.#path; }
  get persistenceError() { return this.#writer.error; }
  get schedules(): readonly PlaylistSchedule[] { return this.#data.schedules; }
  get accounts(): readonly WebAccount[] { return this.#data.accounts; }
  get chatAccess() { return this.#data.chatAccess; }
  settingsFor(bot: string): BotSettings { return settingsFrom(this.#data.settings[bot]); }
  setSettings(bot: string, value: Partial<BotSettings>): void {
    const current = this.settingsFor(bot);
    const merged = { ...current, ...value, queue: { ...current.queue, ...value.queue } };
    if (!["balanced","high"].includes(merged.audioProfile)) throw new Error("Unknown audio profile");
    for (const [v,min,max] of [[merged.queue.maxTracks,1,5000],[merged.queue.perRequester,1,5000],[merged.queue.cooldownSeconds,0,300],[merged.avoidRecent,0,100],[merged.idleReleaseSeconds,15,3600]]) {
      if (!Number.isInteger(v) || v! < min! || v! > max!) throw new Error("Settings contain an out-of-range number");
    }
    if (!Array.isArray(merged.failover) || !merged.failover.every(id => typeof id === "string")) throw new Error("Choose fallback stations");
    const settings = settingsFrom(merged);
    if (settings.failover.some(id => !this.radioStations.some(r => r.id === id))) throw new Error("A fallback station no longer exists");
    this.#data.settings[bot] = settings; this.#save();
  }
  historyFor(bot: string): readonly HistoryEntry[] { return this.#data.history[bot] ?? []; }
  recordStart(bot: string, track: Track): void {
    const history = this.#data.history[bot] ??= [];
    history.unshift({ id: randomUUID(), track: { ...track }, startedAt: new Date().toISOString(), endedAt: null, error: null });
    history.length = Math.min(history.length, 200); this.#save();
  }
  recordEnd(bot: string, track: Track, error?: string): void {
    const entry = this.historyFor(bot).find(h => h.track.url === track.url && !h.endedAt);
    if (entry) { entry.endedAt = new Date().toISOString(); entry.error = error ?? null; this.#save(); }
  }
  saveSchedule(value: Omit<PlaylistSchedule, "id">, id?: string): PlaylistSchedule {
    validateSchedule({ ...value, id: id ?? "" });
    if (!this.find(value.playlistId)?.tracks.length) throw new Error("Choose a non-empty playlist");
    if (id && !this.schedules.some(s => s.id === id)) throw new Error("Schedule not found");
    const slots = (s: Omit<PlaylistSchedule,"id">) => s.days.flatMap(day => {
      const minutes = (time: string) => Number(time.slice(0,2)) * 60 + Number(time.slice(3));
      const start = day * 1440 + minutes(s.start), end = day * 1440 + minutes(s.end) + (s.end < s.start ? 1440 : 0);
      return end > 10080 ? [[start,10080],[0,end-10080]] : [[start,end]];
    });
    for (const other of this.schedules.filter(s => s.bot === value.bot && s.id !== id && s.enabled && value.enabled)) {
      if (other.timezone !== value.timezone) throw new Error("Schedules on one bot must use the same time zone");
      if (slots(other).some(([a,b]) => slots(value).some(([c,d]) => a! < d! && c! < b!))) throw new Error("This schedule overlaps another enabled schedule");
    }
    const schedule = { ...value, days: [...new Set(value.days)], id: id ?? randomUUID() };
    this.#data.schedules = this.#data.schedules.filter(s => s.id !== schedule.id); this.#data.schedules.push(schedule); this.#save();
    return schedule;
  }
  deleteSchedule(id: string): void { this.#data.schedules = this.#data.schedules.filter(s => s.id !== id); this.#save(); }
  saveAccount(account: WebAccount): void {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(account.username) || account.username === "owner") throw new Error("Use 2–32 lowercase letters, numbers, - or _; owner is reserved");
    if (!["listener","dj","admin"].includes(account.role)) throw new Error("Unknown role");
    if (this.accounts.length >= 200 && !this.accounts.some(a => a.username === account.username)) throw new Error("This panel supports up to 200 accounts");
    this.#data.accounts = this.#data.accounts.filter(a => a.username !== account.username); this.#data.accounts.push(account); this.#save();
  }
  deleteAccount(username: string): void { this.#data.accounts = this.#data.accounts.filter(a => a.username !== username); this.#save(); }
  setChatAccess(value: Library["chatAccess"]): void {
    if (!value || typeof value.enabled !== "boolean" || !value.users || !value.groups || typeof value.users !== "object" || typeof value.groups !== "object" || Array.isArray(value.users) || Array.isArray(value.groups)) throw new Error("Invalid chat access policy");
    for (const role of [...Object.values(value.users), ...Object.values(value.groups)]) if (!["listener","dj","admin"].includes(role)) throw new Error("Unknown chat role");
    if (Object.keys(value.users).length + Object.keys(value.groups).length > 200) throw new Error("Too many chat role assignments");
    this.#data.chatAccess = structuredClone(value); this.#save();
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
    delete this.#data.settings[bot];
    this.#data.schedules = this.#data.schedules.filter(s => s.bot !== bot);
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
    for (const settings of Object.values(this.#data.settings)) settings.failover = settings.failover.filter(s => s !== id);
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
    const { requestedBy, requesterId, auto, ...saved } = t;
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
    this.#data.schedules = this.#data.schedules.filter(s => s.playlistId !== list.id);
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
    this.revision++;
    this.#writer.schedule();
    this.onChange?.();
  }
}
