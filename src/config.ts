import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BotConfig {
  server: string;
  serverPassword: string;
  nickname: string;
  /** Channel name or path ("Parent/Child") to join; empty for the server default. */
  channel: string;
  channelPassword: string;
  identityFile: string;
  identityLevel: number;
  ffmpegPath: string;
  bitrateKbps: number;
  /** 0-100. */
  volume: number;
  autoplay: boolean;
  defaultStation: string;
  commandPrefix: string;
  /** Client unique IDs allowed to add/remove stations. Empty means everyone. */
  admins: string[];
}

export interface Station {
  id: string;
  name: string;
  url: string;
}

const defaults: BotConfig = {
  server: "127.0.0.1:9987",
  serverPassword: "",
  nickname: "FM Radio",
  channel: "",
  channelPassword: "",
  identityFile: "identity.txt",
  identityLevel: 8,
  ffmpegPath: "ffmpeg",
  bitrateKbps: 96,
  volume: 50,
  autoplay: true,
  defaultStation: "",
  commandPrefix: "!",
  admins: [],
};

export const CONFIG_PATH = resolve(process.env.FMBOT_CONFIG ?? "config.json");
export const STATIONS_PATH = resolve(process.env.FMBOT_STATIONS ?? "stations.json");

/** Environment overrides, so the bot can be configured from docker-compose without a config file. */
function envOverrides(): Partial<BotConfig> {
  const env = process.env;
  const out: Partial<BotConfig> = {};
  if (env.FMBOT_SERVER) out.server = env.FMBOT_SERVER;
  if (env.FMBOT_SERVER_PASSWORD !== undefined) out.serverPassword = env.FMBOT_SERVER_PASSWORD;
  if (env.FMBOT_NICKNAME) out.nickname = env.FMBOT_NICKNAME;
  if (env.FMBOT_CHANNEL !== undefined) out.channel = env.FMBOT_CHANNEL;
  if (env.FMBOT_CHANNEL_PASSWORD !== undefined) out.channelPassword = env.FMBOT_CHANNEL_PASSWORD;
  if (env.FMBOT_VOLUME) out.volume = Number(env.FMBOT_VOLUME);
  if (env.FMBOT_DEFAULT_STATION) out.defaultStation = env.FMBOT_DEFAULT_STATION;
  if (env.FMBOT_ADMINS !== undefined) out.admins = env.FMBOT_ADMINS.split(",").map((s) => s.trim()).filter(Boolean);
  return out;
}

export function loadConfig(): BotConfig {
  const env = envOverrides();
  let raw: Partial<BotConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<BotConfig>;
  } else if (!env.server) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json to config.json and edit it, or set FMBOT_SERVER.`);
  }
  const config = { ...defaults, ...raw, ...env };
  config.volume = clampVolume(config.volume);
  return config;
}

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
}

export function loadStations(): Station[] {
  if (!existsSync(STATIONS_PATH)) return [];
  const list = JSON.parse(readFileSync(STATIONS_PATH, "utf8")) as Station[];
  return list.filter((s) => s && s.id && s.url).map((s) => ({ ...s, name: s.name || s.id }));
}

export function saveStations(stations: Station[]): void {
  writeFileSync(STATIONS_PATH, JSON.stringify(stations, null, 2) + "\n");
}
