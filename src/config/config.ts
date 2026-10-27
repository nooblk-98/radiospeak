/** Configuration defaults and validation; data paths remain relative to the working directory. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BotPlatform = "teamspeak" | "discord";
export interface DiscordConfig {
  token: string;
  guildId: string;
  channelId: string;
}
/** One voice connection. Existing configurations default to TeamSpeak. */
export interface BotConfig {
  platform?: BotPlatform;
  discord?: DiscordConfig;
  /** Short name used in logs and the web panel. */
  name: string;
  nickname: string;
  /** Channel name or path ("Parent/Child") to join; empty for the server default. */
  channel: string;
  channelPassword: string;
  identityFile: string;
  /** 0-100. */
  volume: number;
  /** YouTube playlist link (or a song inside one) played whenever nobody has requested anything. */
  defaultPlaylist: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Administrator panel password; empty means no login (only safe on localhost). */
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
  /** Most songs taken from one playlist link. */
  maxPlaylistItems: number;
  /** Client unique IDs allowed to run admin commands. */
  admins: string[];
  /** Server group IDs allowed to run admin commands. With both lists empty, everyone is an admin. */
  adminGroups: number[];
  /** Pause while nobody is listening in the bot's channel. */
  pauseWhenEmpty: boolean;
  emptyGraceSeconds: number;
  /** Put the song in the bot's description. */
  songInDescription: boolean;
  web: WebConfig;
  bots: BotConfig[];
}

export const CONFIG_PATH = resolve(process.env.FMBOT_CONFIG ?? "config.json");
export const PLAYLISTS_PATH = resolve(process.env.FMBOT_PLAYLISTS ?? "playlists.json");

const botDefaults: Omit<BotConfig, "name" | "identityFile"> = {
  nickname: "radiospeak",
  channel: "",
  channelPassword: "",
  volume: 50,
  defaultPlaylist: "",
};

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
}

export function validateNickname(value: string): string {
  const nickname = value.trim();
  if (!nickname || [...nickname].length > 30 || /[\u0000-\u001f\u007f-\u009f]/.test(nickname)) {
    throw new Error("Bot name must contain 1–30 characters with no control characters");
  }
  return nickname;
}

/** Instance names become file names (identity-<name>.txt), so panel-created ones stay simple. */
export function validateBotName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][\w-]{0,23}$/.test(name))
    throw new Error("Instance ID must be 1–24 letters, numbers, - or _");
  return name;
}

/** A bot added in the web panel: the first bot's connection settings, its own identity, and no configured channel or playlist. */
export function instanceConfig(template: BotConfig, name: string): BotConfig {
  const { discord, ...shared } = template;
  return {
    ...shared,
    platform: "teamspeak",
    name,
    channel: "",
    channelPassword: "",
    defaultPlaylist: "",
    identityFile: `identity-${name}.txt`,
  };
}

export function discordSnowflake(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error(`Enter a valid Discord ${label} ID`);
  return value;
}
export function validateDiscordConfig(value: DiscordConfig): DiscordConfig {
  const token = typeof value?.token === "string" ? value.token.trim().replace(/^Bot\s+/i, "") : "";
  if (!/^[A-Za-z0-9_.-]{20,200}$/.test(token))
    throw new Error("Enter a Discord bot token from the Developer Portal");
  return {
    token,
    guildId: discordSnowflake(value.guildId, "server"),
    channelId: discordSnowflake(value.channelId, "voice channel"),
  };
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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
  set("defaultPlaylist", e.FMBOT_DEFAULT_PLAYLIST);
  set(
    "maxPlaylistItems",
    e.FMBOT_MAX_PLAYLIST_ITEMS ? Number(e.FMBOT_MAX_PLAYLIST_ITEMS) : undefined,
  );
  set("bitrateKbps", e.FMBOT_BITRATE ? Number(e.FMBOT_BITRATE) : undefined);
  set("admins", list(e.FMBOT_ADMINS));
  set("adminGroups", list(e.FMBOT_ADMIN_GROUPS)?.map(Number).filter(Number.isFinite));
  set("pauseWhenEmpty", bool(e.FMBOT_PAUSE_WHEN_EMPTY));
  set("songInDescription", bool(e.FMBOT_SONG_IN_DESCRIPTION));
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
  } else if (!env.server && !env.bots?.length) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.example.json to config.json and edit it, or set FMBOT_SERVER.`,
    );
  }
  const raw: RawConfig = { ...file, ...env, web: { ...file.web, ...env.web } };

  // Top-level bot fields are the single-bot shorthand and the defaults for every bot in `bots`.
  const shared: Omit<BotConfig, "name" | "identityFile"> = {
    nickname: validateNickname(raw.nickname ?? botDefaults.nickname),
    channel: raw.channel ?? botDefaults.channel,
    channelPassword: raw.channelPassword ?? botDefaults.channelPassword,
    volume: raw.volume ?? botDefaults.volume,
    defaultPlaylist: raw.defaultPlaylist ?? botDefaults.defaultPlaylist,
  };
  const botList = raw.bots?.length ? raw.bots : [{ platform: raw.platform, discord: raw.discord }];
  const bots = botList.map((b, i): BotConfig => {
    const name = b.name || `bot${i + 1}`;
    if (b.platform !== undefined && !["teamspeak", "discord"].includes(b.platform))
      throw new Error("Unknown bot platform");
    if (b.platform === "discord") validateBotName(name);
    return {
      ...shared,
      ...b,
      name,
      nickname: validateNickname(b.nickname ?? shared.nickname),
      platform: b.platform ?? "teamspeak",
      ...(b.platform === "discord" ? { discord: validateDiscordConfig(b.discord!) } : {}),
      // The first bot keeps the original identity.txt so upgrading does not change its unique ID.
      identityFile:
        b.identityFile || (i === 0 ? raw.identityFile || "identity.txt" : `identity-${name}.txt`),
      volume: clampVolume(b.volume ?? shared.volume),
    };
  });
  if (new Set(bots.map((bot) => bot.name.toLowerCase())).size !== bots.length)
    throw new Error("Bot instance IDs must be unique across all platforms");

  return {
    server: raw.server ?? "127.0.0.1:9987",
    serverPassword: raw.serverPassword ?? "",
    identityLevel: raw.identityLevel ?? 8,
    ffmpegPath: raw.ffmpegPath ?? "ffmpeg",
    ytdlpPath: raw.ytdlpPath ?? "yt-dlp",
    bitrateKbps: raw.bitrateKbps ?? 96,
    commandPrefix: raw.commandPrefix ?? "!",
    maxPlaylistItems: Number.isFinite(raw.maxPlaylistItems)
      ? Math.max(1, Math.min(5000, Math.floor(raw.maxPlaylistItems!)))
      : 300,
    admins: raw.admins ?? [],
    adminGroups: raw.adminGroups ?? [],
    pauseWhenEmpty: raw.pauseWhenEmpty ?? true,
    emptyGraceSeconds: raw.emptyGraceSeconds ?? 15,
    songInDescription: raw.songInDescription ?? true,
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: raw.web?.port ?? 8080,
      password: raw.web?.password ?? "",
    },
    bots,
  };
}
