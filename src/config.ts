import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** One TeamSpeak connection. Several can run in one process, e.g. one per channel. */
export interface BotConfig {
  /** Short name used in logs, the web panel and schedule entries. */
  name: string;
  nickname: string;
  /** Channel name or path ("Parent/Child") to join; empty for the server default. */
  channel: string;
  channelPassword: string;
  identityFile: string;
  /** 0-100. */
  volume: number;
  autoplay: boolean;
  defaultStation: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Basic-auth password for the panel; empty means no login (only safe on localhost). */
  password: string;
}

export interface AppConfig {
  server: string;
  serverPassword: string;
  identityLevel: number;
  ffmpegPath: string;
  ytdlpPath: string;
  bitrateKbps: number;
  commandPrefix: string;
  /** Client unique IDs allowed to run admin commands. */
  admins: string[];
  /** Server group IDs allowed to run admin commands. With both lists empty, everyone is an admin. */
  adminGroups: number[];
  /** Stop streaming while nobody is listening in the bot's channel. */
  pauseWhenEmpty: boolean;
  emptyGraceSeconds: number;
  /** Show the station in the bot's nickname, e.g. "FM Radio | Shaa FM". */
  showStationInNickname: boolean;
  /** Put the current song title in the bot's description. */
  songInDescription: boolean;
  /** Post song changes to the channel chat. */
  announceSongs: boolean;
  /** IANA time zone for the schedule, e.g. "Asia/Colombo". */
  timezone: string;
  web: WebConfig;
  bots: BotConfig[];
}

export interface Station {
  id: string;
  name: string;
  url: string;
  /** Tried in order when the main URL keeps failing. */
  backupUrls?: string[];
}

export interface ScheduleEntry {
  /** "HH:MM", 24-hour, in AppConfig.timezone. */
  time: string;
  /** Lowercase three-letter days ("mon", "tue", ...); empty or missing means every day. */
  days?: string[];
  /** Station id to play, or "stop". */
  station: string;
  /** Bot name; missing means every bot. */
  bot?: string;
  volume?: number;
}

export const CONFIG_PATH = resolve(process.env.FMBOT_CONFIG ?? "config.json");
export const STATIONS_PATH = resolve(process.env.FMBOT_STATIONS ?? "stations.json");
export const SCHEDULE_PATH = resolve(process.env.FMBOT_SCHEDULE ?? "schedule.json");

const botDefaults: Omit<BotConfig, "name" | "identityFile"> = {
  nickname: "FM Radio",
  channel: "",
  channelPassword: "",
  volume: 50,
  autoplay: true,
  defaultStation: "",
};

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);
}

type RawConfig = Partial<Omit<AppConfig, "web" | "bots">> &
  Partial<Omit<BotConfig, "name">> & { web?: Partial<WebConfig>; bots?: Partial<BotConfig>[] };

/** Environment overrides, so the bot can be configured from docker-compose without a config file. */
function envOverrides(): RawConfig {
  const e = process.env;
  const out: RawConfig = {};
  const set = <K extends keyof RawConfig>(key: K, value: RawConfig[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("server", e.FMBOT_SERVER || undefined);
  set("serverPassword", e.FMBOT_SERVER_PASSWORD);
  set("nickname", e.FMBOT_NICKNAME || undefined);
  set("channel", e.FMBOT_CHANNEL);
  set("channelPassword", e.FMBOT_CHANNEL_PASSWORD);
  set("volume", e.FMBOT_VOLUME ? Number(e.FMBOT_VOLUME) : undefined);
  set("defaultStation", e.FMBOT_DEFAULT_STATION || undefined);
  set("admins", list(e.FMBOT_ADMINS));
  set("adminGroups", list(e.FMBOT_ADMIN_GROUPS)?.map(Number).filter(Number.isFinite));
  set("pauseWhenEmpty", bool(e.FMBOT_PAUSE_WHEN_EMPTY));
  set("showStationInNickname", bool(e.FMBOT_STATION_IN_NICKNAME));
  set("songInDescription", bool(e.FMBOT_SONG_IN_DESCRIPTION));
  set("announceSongs", bool(e.FMBOT_ANNOUNCE_SONGS));
  set("timezone", e.FMBOT_TIMEZONE || undefined);
  if (e.FMBOT_BOTS) out.bots = JSON.parse(e.FMBOT_BOTS) as Partial<BotConfig>[];
  const web: Partial<WebConfig> = {};
  if (bool(e.FMBOT_WEB_ENABLED) !== undefined) web.enabled = bool(e.FMBOT_WEB_ENABLED);
  if (e.FMBOT_WEB_HOST) web.host = e.FMBOT_WEB_HOST;
  if (e.FMBOT_WEB_PORT) web.port = Number(e.FMBOT_WEB_PORT);
  if (e.FMBOT_WEB_PASSWORD !== undefined) web.password = e.FMBOT_WEB_PASSWORD;
  if (Object.keys(web).length) out.web = web;
  return out;
}

export function loadConfig(): AppConfig {
  const env = envOverrides();
  let file: RawConfig = {};
  if (existsSync(CONFIG_PATH)) {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as RawConfig;
  } else if (!env.server) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json to config.json and edit it, or set FMBOT_SERVER.`);
  }
  const raw: RawConfig = { ...file, ...env, web: { ...file.web, ...env.web } };

  // Top-level bot fields are the single-bot shorthand and the defaults for every bot in `bots`.
  const shared: Omit<BotConfig, "name" | "identityFile"> = {
    nickname: raw.nickname ?? botDefaults.nickname,
    channel: raw.channel ?? botDefaults.channel,
    channelPassword: raw.channelPassword ?? botDefaults.channelPassword,
    volume: raw.volume ?? botDefaults.volume,
    autoplay: raw.autoplay ?? botDefaults.autoplay,
    defaultStation: raw.defaultStation ?? botDefaults.defaultStation,
  };
  const botList = raw.bots?.length ? raw.bots : [{}];
  const bots = botList.map((b, i): BotConfig => {
    const name = b.name || `bot${i + 1}`;
    return {
      ...shared,
      ...b,
      name,
      // The first bot keeps the original identity.txt so upgrading does not change its unique ID.
      identityFile: b.identityFile || (i === 0 ? raw.identityFile || "identity.txt" : `identity-${name}.txt`),
      volume: clampVolume(b.volume ?? shared.volume),
    };
  });

  return {
    server: raw.server ?? "127.0.0.1:9987",
    serverPassword: raw.serverPassword ?? "",
    identityLevel: raw.identityLevel ?? 8,
    ffmpegPath: raw.ffmpegPath ?? "ffmpeg",
    ytdlpPath: raw.ytdlpPath ?? "yt-dlp",
    bitrateKbps: raw.bitrateKbps ?? 96,
    commandPrefix: raw.commandPrefix ?? "!",
    admins: raw.admins ?? [],
    adminGroups: raw.adminGroups ?? [],
    pauseWhenEmpty: raw.pauseWhenEmpty ?? true,
    emptyGraceSeconds: raw.emptyGraceSeconds ?? 15,
    showStationInNickname: raw.showStationInNickname ?? true,
    songInDescription: raw.songInDescription ?? true,
    announceSongs: raw.announceSongs ?? false,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: raw.web?.port ?? 8080,
      password: raw.web?.password ?? "",
    },
    bots,
  };
}
