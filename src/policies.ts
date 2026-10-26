export type Role = "listener" | "dj" | "admin";
export interface Viewer { id: string; username: string; role: Role }
export const owner: Viewer = { id: "web:owner", username: "owner", role: "admin" };
export type AudioProfile = "balanced" | "high";
export interface QueuePolicy { maxTracks: number; perRequester: number; cooldownSeconds: number }
export interface BotSettings {
  audioProfile: AudioProfile; queue: QueuePolicy; avoidRecent: number; idleReleaseSeconds: number;
  failover: string[];
  silence?: { enabled: boolean; thresholdDb: number; seconds: number; radioFailover: boolean };
}
export const defaultSettings: BotSettings = {
  audioProfile: "high", queue: { maxTracks: 500, perRequester: 50, cooldownSeconds: 3 },
  avoidRecent: 10, idleReleaseSeconds: 120, failover: [],
};
export function settingsFrom(value: Partial<BotSettings> = {}): BotSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return {
    audioProfile: value.audioProfile === "balanced" ? "balanced" : "high",
    queue: { maxTracks: number(value.queue?.maxTracks, 500, 1, 5000), perRequester: number(value.queue?.perRequester, 50, 1, 5000), cooldownSeconds: number(value.queue?.cooldownSeconds, 3, 0, 300) },
    avoidRecent: number(value.avoidRecent, 10, 0, 100), idleReleaseSeconds: number(value.idleReleaseSeconds, 120, 15, 3600),
    failover: Array.isArray(value.failover) ? [...new Set(value.failover.filter(s => typeof s === "string"))].slice(0, 20) : [],
    silence: { enabled: value.silence?.enabled === true, thresholdDb: number(value.silence?.thresholdDb,-55,-90,-20), seconds: number(value.silence?.seconds,30,5,600), radioFailover: value.silence?.radioFailover === true },
  };
}
export interface PlaylistSchedule {
  id: string; bot: string; playlistId: string; days: number[]; start: string; end: string; timezone: string; enabled: boolean;
}
export function validateSchedule(value: PlaylistSchedule): void {
  if (typeof value.timezone !== "string" || !value.timezone || typeof value.enabled !== "boolean") throw new Error("Choose a time zone and enabled state");
  if (!Array.isArray(value.days) || !value.days.length || !value.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error("Choose one or more days");
  if (![value.start, value.end].every(t => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || value.start === value.end) throw new Error("Choose different valid start and end times");
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(); } catch { throw new Error("Unknown time zone"); }
}
export function validateScheduleConflicts(value: PlaylistSchedule, others: readonly PlaylistSchedule[]): void {
  const slots = (s: PlaylistSchedule) => s.days.flatMap(day => {
    const minutes=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
    const start=day*1440+minutes(s.start),end=day*1440+minutes(s.end)+(s.end<s.start?1440:0);
    return end>10080?[[start,10080],[0,end-10080]]:[[start,end]];
  });
  for(const other of others.filter(s=>s.bot===value.bot && s.id!==value.id && s.enabled && value.enabled)) {
    if(other.timezone!==value.timezone)throw new Error("Schedules on one bot must use the same time zone");
    if(slots(other).some(([a,b])=>slots(value).some(([c,d])=>a!<d! && c!<b!)))throw new Error("This schedule overlaps another enabled schedule");
  }
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function activeSchedule(schedules: readonly PlaylistSchedule[], bot: string, now = new Date()): PlaylistSchedule | undefined {
  return schedules.find(s => {
    if (!s.enabled || s.bot !== bot) return false;
    let formatter = formatters.get(s.timezone);
    if (!formatter) { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(s.timezone, formatter); }
    const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
    const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts.weekday!);
    const time = parts.hour + ":" + parts.minute;
    return s.start < s.end ? s.days.includes(day) && time >= s.start && time < s.end
      : (s.days.includes(day) && time >= s.start) || (s.days.includes((day + 6) % 7) && time < s.end);
  });
}

/** A small shared budget for speculative work; live playback never waits on it. */
export class PrebufferBudget {
  #used = 0;
  #waiting = new Set<() => void>();
  readonly limit: number;
  constructor(limit = 2) { this.limit = limit; }
  get used() { return this.#used; }
  onAvailable(callback: () => void) { this.#waiting.add(callback); return () => { this.#waiting.delete(callback); }; }
  acquire(): (() => void) | undefined {
    if (this.#used >= this.limit) return;
    this.#used++;
    let released = false;
    return () => { if (!released) { released = true; this.#used--; const waiting=[...this.#waiting];this.#waiting.clear();for(const callback of waiting)queueMicrotask(callback); } };
  }
}
export const prebufferBudget = new PrebufferBudget(2);
