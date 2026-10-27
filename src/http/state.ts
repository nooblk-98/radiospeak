/** Public panel snapshots. Credentials and internal import keys never enter this payload. */
import { type App } from "../app/context.ts";
import { MusicBot } from "../bots/music-bot.ts";
import type { SavedPlaylist } from "../library/store.ts";
import { mediaStats } from "../media/ytdlp.ts";

import { uiVersion } from "./assets.ts";
import { imports, MAX_INSTANCES, panelManaged } from "./context.ts";
import { trackJson } from "./helpers.ts";

const summaries = new WeakMap<SavedPlaylist, { key: string; value: object }>();
function summary(p: SavedPlaylist) {
  const key = p.version + "|" + p.collectionId;
  let entry = summaries.get(p);
  if (!entry || entry.key !== key) {
    entry = {
      key,
      value: {
        id: p.id,
        name: p.name,
        collectionId: p.collectionId,
        version: p.version,
        trackCount: p.tracks.length,
        totalDuration: p.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
        coverTrack: p.tracks[0] ?? null,
      },
    };
    summaries.set(p, entry);
  }
  return entry.value;
}
export function stateFor(app: App) {
  return {
    uiVersion,
    authEnabled: app.config.web.password !== "",
    bots: app.bots.map((b) => ({
      ...botState(b),
      removable: panelManaged(app, b.name),
      welcomes: app.playlists.welcomes(b.name),
    })),
    maxInstances: MAX_INSTANCES,
    collections: app.playlists.collections,
    defaults: app.playlists.defaults,
    radioStations: app.playlists.radioStations,
    schedules: app.playlists.schedules,
    favorites: app.playlists.favorites.map(trackJson),
    commandPrefix: app.config.commandPrefix,
    playlists: app.playlists.all.map(summary),
    imports: imports(app).all.map((job) => ({
      ...job,
      errors: job.errors.slice(0, 20),
      failedIndices: undefined,
      input: undefined,
    })),
    system: stateForSystem(),
  };
}
export function stateForSystem() {
  return {
    pid: process.pid,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    media: mediaStats(),
  };
}
export function botState(bot: MusicBot) {
  const pl = bot.player;
  return {
    name: bot.name,
    revision: bot.revision,
    generation: bot.generation,
    nickname: bot.nickname,
    connected: bot.connected,
    platform: bot.platform,
    serverName: bot.serverName,
    connectionError: bot.connectionError,
    discord: bot.discord,
    channel: bot.channelName ?? null,
    channelId: bot.channelId ?? null,
    homeChannel: bot.homeChannel || null,
    channels: bot.channels,
    talkBlocked: bot.talkBlocked ?? null,
    currentPlaylist: ((list) => (list ? { id: list.id, name: list.name } : null))(
      bot.playlistOf(pl.track),
    ),
    track: pl.track ? trackJson(pl.track) : null,
    elapsed: pl.elapsed,
    queue: pl.queue.map(trackJson),
    radio: pl.radio ?? null,
    radioTitle: bot.radioTitle ?? null,
    defaultPlaylist: pl.defaultPlaylist,
    volume: pl.volume,
    userPaused: pl.userPaused,
    autoPaused: pl.autoPaused,
    loop: pl.loop,
    connectionPaused: pl.connectionPaused,
    lastDisconnect: bot.lastDisconnect ?? null,
    normalization: pl.normalization,
    shuffle: pl.shuffleEnabled,
    canGoBack: pl.canGoBack,
    listeners: bot.listeners().map((c) => c.nickname),
    health: bot.health,
    settings: bot.settings,
    activeSchedule: bot.activeSchedule ?? null,
    votes: bot.votes,
    historyVersion: bot.historyVersion,
  };
}

/** Acknowledge fast controls without making the browser fetch the entire library again. */
export function playbackUpdate(bot: MusicBot) {
  return {
    name: bot.name,
    revision: bot.revision,
    generation: bot.generation,
    trackUrl: bot.player.track?.url ?? null,
    elapsed: bot.player.elapsed,
    volume: bot.player.volume,
    health: bot.health,
  };
}
