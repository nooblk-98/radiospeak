import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SCHEDULE_PATH, STATIONS_PATH, type ScheduleEntry, type Station } from "./config.ts";

/** A JSON array on disk that chat commands, the web panel and the scheduler all edit. */
class JsonListStore<T> {
  #path: string;
  #items: T[];

  constructor(path: string, normalize: (items: T[]) => T[]) {
    this.#path = path;
    this.#items = existsSync(path) ? normalize(JSON.parse(readFileSync(path, "utf8")) as T[]) : [];
  }

  get items(): readonly T[] {
    return this.#items;
  }

  protected replace(items: T[]): void {
    this.#items = items;
    writeFileSync(this.#path, JSON.stringify(items, null, 2) + "\n");
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "station"
  );
}

export class StationStore extends JsonListStore<Station> {
  constructor(path = STATIONS_PATH) {
    super(path, (list) =>
      list.filter((s) => s && s.id && s.url).map((s) => ({ ...s, name: s.name || s.id })),
    );
  }

  /** By list number (1-based), id, exact name, then partial name or id. */
  find(query: string): Station | undefined {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;
    const list = this.items;
    const n = Number(q);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
    return (
      list.find((s) => s.id.toLowerCase() === q) ??
      list.find((s) => s.name.toLowerCase() === q) ??
      list.find((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    );
  }

  indexOf(id: string | undefined): number {
    return id === undefined ? -1 : this.items.findIndex((s) => s.id === id);
  }

  /** A free id based on `wanted` (or the name), so adding from search never collides. */
  uniqueId(wanted: string): string {
    const base = slugify(wanted);
    let id = base;
    for (let i = 2; this.items.some((s) => s.id.toLowerCase() === id); i++) id = `${base}-${i}`;
    return id;
  }

  add(station: Station): Station {
    if (this.items.some((s) => s.id.toLowerCase() === station.id.toLowerCase())) {
      throw new Error(`Station id "${station.id}" already exists`);
    }
    this.replace([...this.items, station]);
    return station;
  }

  remove(id: string): Station | undefined {
    const station = this.items.find((s) => s.id === id);
    if (station) this.replace(this.items.filter((s) => s.id !== id));
    return station;
  }
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class ScheduleStore extends JsonListStore<ScheduleEntry> {
  constructor(path = SCHEDULE_PATH) {
    super(path, (list) => list.filter((e) => e && /^\d{1,2}:\d{2}$/.test(e.time) && e.station));
  }

  add(entry: ScheduleEntry): ScheduleEntry {
    const [h = "", m = ""] = entry.time.split(":");
    const hour = Number(h);
    const minute = Number(m);
    if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) throw new Error(`Bad time "${entry.time}", use HH:MM`);
    const days = entry.days?.map((d) => d.toLowerCase().slice(0, 3)).filter((d) => DAYS.includes(d));
    const clean: ScheduleEntry = {
      ...entry,
      time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ...(days?.length ? { days } : { days: undefined }),
    };
    if (!clean.days) delete clean.days;
    this.replace([...this.items, clean].sort((a, b) => a.time.localeCompare(b.time)));
    return clean;
  }

  /** 1-based, as shown by `describe`. */
  removeAt(n: number): ScheduleEntry | undefined {
    const entry = this.items[n - 1];
    if (entry) this.replace(this.items.filter((_, i) => i !== n - 1));
    return entry;
  }

  static describe(e: ScheduleEntry): string {
    const days = e.days?.length ? e.days.join(",") : "daily";
    const what = e.station === "stop" ? "stop" : `play ${e.station}`;
    return `${e.time} ${days} — ${what}${e.volume !== undefined ? ` vol ${e.volume}` : ""}${e.bot ? ` (${e.bot})` : ""}`;
  }

  static readonly DAYS = DAYS;
}
