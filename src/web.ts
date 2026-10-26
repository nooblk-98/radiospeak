import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { asChannelID } from "@honeybbq/teamspeak";
import { log, type App, type MusicBot } from "./bot.ts";
import { clampVolume } from "./config.ts";
import type { LoopMode, Track } from "./player.ts";
import { resolve } from "./ytdlp.ts";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/api.js", ["api.js", "text/javascript"]],
  ["/components.js", ["components.js", "text/javascript"]],
].map(([path, [file, type]]) => [path, { body: readFileSync(join(import.meta.dirname, "web", file!)), type }]));

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const plain = (s: string) => s.replace(/\[\/?b\]/g, "");
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const httpUrl = (s: unknown): string | undefined => {
  try {
    const url = new URL(str(s));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
};
const trackJson = (t: Track) => ({ ...t, duration: t.duration ?? null, requestedBy: t.requestedBy ?? null, auto: !!t.auto });

function botState(bot: MusicBot) {
  const pl = bot.player;
  return {
    name: bot.name, nickname: bot.nickname, connected: bot.connected,
    channel: bot.channelName ?? null, channelId: bot.channelID?.toString() ?? null,
    channels: bot.connected ? [...(bot.client?.view.channels.values() ?? [])].map((c) => ({ id: c.id.toString(), name: c.name })) : [],
    talkBlocked: bot.talkBlocked ?? null,
    track: pl.track ? trackJson(pl.track) : null, elapsed: pl.elapsed,
    queue: pl.queue.map(trackJson), radio: pl.radio ?? null, radioTitle: bot.radioTitle ?? null,
    defaultPlaylist: pl.defaultPlaylist, volume: pl.volume,
    userPaused: pl.userPaused, autoPaused: pl.autoPaused, loop: pl.loop,
    connectionPaused: pl.connectionPaused, lastDisconnect: bot.lastDisconnect ?? null,
    normalization: pl.normalization, shuffle: pl.shuffleEnabled, canGoBack: pl.canGoBack,
    listeners: bot.listeners().map((c) => c.nickname),
  };
}

function authorized(req: IncomingMessage, password: string): boolean {
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.includes("application/json")) throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, "Invalid JSON object"); }
}

function tracksFrom(v: unknown): Track[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const url = httpUrl(o.url);
    if (!url) return [];
    const duration = Number(o.duration);
    const thumbnail = httpUrl(o.thumbnail);
    return [{ url, title: str(o.title) || url,
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      ...(str(o.artist) ? { artist: str(o.artist) } : {}), ...(thumbnail ? { thumbnail } : {}) }];
  });
}

/** Reject stale positional edits instead of accidentally changing a different track. */
function checkOrder(tracks: readonly Track[], body: Record<string, unknown>): void {
  if (body.expected !== undefined && JSON.stringify(body.expected) !== JSON.stringify(tracks.map((t) => t.url))) {
    throw new HttpError(409, "The list changed. Refreshed it; please try again.");
  }
}

function syncDefaults(app: App): void {
  for (const bot of app.bots) {
    if (!app.playlists.hasDefault(bot.name)) continue;
    const list = app.playlists.defaultFor(bot.name);
    bot.player.setDefaultPlaylist(list?.tracks ?? [], list?.name);
  }
}
function selectedBot(app: App, value: unknown): MusicBot {
  const bot = value ? app.bots.find((b) => b.name === str(value)) : app.bots[0];
  if (!bot) throw new HttpError(404, "No such bot");
  return bot;
}

async function botAction(app: App, bot: MusicBot, action: string, body: Record<string, unknown>): Promise<string> {
  const pl = bot.player;
  switch (action) {
    case "play": {
      const input = str(body.input);
      if (!input) throw new HttpError(400, "Enter a link or search words");
      return bot.play(input, { requestedBy: "web", next: body.next === true, wholePlaylist: body.all === true });
    }
    case "enqueue":
    case "play-now": {
      const tracks = tracksFrom(body.tracks);
      if (!tracks.length) throw new HttpError(400, "No playable tracks");
      if (action === "play-now") {
        pl.playNow(tracks.map((t) => ({ ...t, requestedBy: "web" })));
        return "Playing now.";
      }
      return bot.enqueue(tracks, { requestedBy: "web", next: body.next === true });
    }
    case "start": return pl.playIfIdle() ? "Playing." : "Nothing to play.";
    case "pause": pl.pause(); return "Paused.";
    case "resume": pl.resume(); return "Resumed.";
    case "skip": return pl.skip(Math.max(1, Number(body.count) || 1)) ? "Skipped." : "Nothing playing.";
    case "previous": return pl.previous() ? "Previous track." : "No previous track.";
    case "stop": return bot.stop();
    case "clear": checkOrder(pl.queue, body); pl.clearQueue(); return "Queue cleared.";
    case "shuffle": pl.setShuffle(body.enabled !== false); return body.enabled === false ? "Shuffle off." : "Shuffle on.";
    case "loop": {
      const mode = str(body.mode) as LoopMode;
      if (!["off", "one", "all"].includes(mode)) throw new HttpError(400, "Loop must be off, one or all");
      pl.setLoop(mode); return "Repeat: " + mode;
    }
    case "volume": {
      if (!Number.isFinite(body.volume)) throw new HttpError(400, "Volume must be a number");
      return bot.setVolume(clampVolume(Number(body.volume)));
    }
    case "seek":
      if (body.url !== pl.track?.url) throw new HttpError(409, "The track changed. Please try again.");
      if (!pl.seek(Number(body.seconds))) throw new HttpError(400, "This track cannot be seeked");
      return "Playback position updated.";
    case "normalization": pl.setNormalization(body.enabled === true); return "Audio normalization updated.";
    case "nickname":
      await bot.setNickname(str(body.nickname));
      return "Bot name saved.";
    case "remove": {
      checkOrder(pl.queue, body);
      const removed = pl.removeAt(Number(body.position));
      if (!removed) throw new HttpError(404, "No such queue position");
      return "Removed " + removed.title;
    }
    case "move": {
      checkOrder(pl.queue, body);
      if (!pl.moveAt(Number(body.from), Number(body.to))) throw new HttpError(400, "Invalid queue positions");
      return "Queue reordered.";
    }
    case "channel": {
      if (!bot.connected) throw new HttpError(400, "Connect the bot before switching channels");
      const channel = [...(bot.client?.view.channels.values() ?? [])].find((c) => c.id.toString() === str(body.channelId));
      if (!channel) throw new HttpError(404, "Channel not found");
      await bot.moveTo(asChannelID(channel.id));
      return "Moved to " + channel.name;
    }
    case "default": {
      const list = body.playlistId === null ? null : app.playlists.find(str(body.playlistId));
      if (list === undefined) throw new HttpError(404, "Playlist not found");
      app.playlists.setDefault(bot.name, list);
      syncDefaults(app);
      return list ? list.name + " is now the default idle playlist." : "Idle playlist disabled.";
    }
    case "radio": {
      const url = str(body.url);
      if (url && !httpUrl(url)) throw new HttpError(400, "Enter a valid HTTP or HTTPS stream URL");
      return bot.playRadio(url || undefined);
    }
  }
  throw new HttpError(404, "Unknown action");
}

export async function route(app: App, req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const store = app.playlists;
  if (method === "GET" && url.pathname === "/api/state") {
    return {
      bots: app.bots.map(botState), collections: store.collections, defaults: store.defaults,
      favorites: store.favorites.map(trackJson), commandPrefix: app.config.commandPrefix,
      playlists: store.all.map((p) => ({ ...p, tracks: p.tracks.map(trackJson) })),
    };
  }
  if (method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q || q.length > 1000) throw new HttpError(400, "Enter a search or public media URL (up to 1,000 characters)");
    const source = url.searchParams.get("source") === "soundcloud" ? "soundcloud" : "youtube";
    return (await resolve(app.config.ytdlpPath, q, { maxItems: 10, results: 10, source })).tracks.map(trackJson);
  }
  if (method === "POST" && url.pathname === "/api/favorites") {
    const [track] = tracksFrom([(await readJson(req)).track]);
    if (!track) throw new HttpError(400, "No track to save");
    return { message: store.toggleFavorite(track) ? "Saved to favorites." : "Removed from favorites." };
  }
  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && parts[3] && method === "POST") {
    return { message: plain(await botAction(app, selectedBot(app, parts[2]), parts[3], await readJson(req))) };
  }
  if (parts[0] === "api" && parts[1] === "collections") {
    if (method === "POST" && parts.length === 2) {
      const collection = store.createCollection(str((await readJson(req)).name));
      return { message: "Collection created.", collection };
    }
    if (parts[2] && method === "PATCH") {
      store.renameCollection(parts[2], str((await readJson(req)).name));
      return { message: "Collection renamed." };
    }
    if (parts[2] && method === "DELETE") {
      store.deleteCollection(parts[2]);
      return { message: "Collection deleted. Its playlists are now standalone." };
    }
  }
  if (url.pathname === "/api/playlists" && method === "POST") {
    const body = await readJson(req);
    const list = store.create(str(body.name), str(body.collectionId) || null);
    return { message: "Created " + list.name, playlist: list };
  }
  if (parts[0] === "api" && parts[1] === "playlists" && parts[2]) {
    const list = store.find(parts[2]);
    if (!list) throw new HttpError(404, "No such playlist");
    if (method === "PATCH" && parts.length === 3) {
      const body = await readJson(req);
      store.update(list, str(body.name) || list.name, body.collectionId === undefined ? list.collectionId : str(body.collectionId) || null);
      syncDefaults(app);
      return { message: "Playlist updated." };
    }
    if (method === "DELETE" && parts.length === 3) {
      store.delete(list); syncDefaults(app);
      return { message: "Deleted " + list.name };
    }
    if (method === "DELETE" && parts[3] === "tracks" && parts[4]) {
      checkOrder(list.tracks, await readJson(req));
      const removed = store.removeTrack(list, Number(parts[4]));
      if (!removed) throw new HttpError(404, "No such song");
      syncDefaults(app);
      return { message: "Removed " + removed.title };
    }
    if (method === "POST" && parts[3]) {
      const body = await readJson(req);
      const bot = selectedBot(app, body.bot);
      switch (parts[3]) {
        case "move":
          checkOrder(list.tracks, body);
          store.moveTrack(list, Number(body.from), Number(body.to));
          syncDefaults(app);
          return { message: "Playlist reordered." };
        case "add": {
          const input = str(body.input);
          let tracks = tracksFrom(body.tracks);
          if (input) tracks = (await resolve(app.config.ytdlpPath, input, { maxItems: app.config.maxPlaylistItems, wholePlaylist: true })).tracks;
          else if (body.current === true && bot.player.track) tracks = [bot.player.track];
          if (!tracks.length) throw new HttpError(400, "Nothing to add");
          // The asynchronous import may have outlived the playlist.
          if (!store.all.includes(list)) throw new HttpError(409, "The playlist was deleted during import");
          store.addTracks(list, tracks); syncDefaults(app);
          return { message: "Added " + tracks.length + " track(s) to " + list.name };
        }
        case "play":
          if (!list.tracks.length) throw new HttpError(400, "Playlist is empty");
          return { message: plain(bot.enqueue([...list.tracks], { requestedBy: "web", playlistName: list.name })) };
        case "save": {
          const tracks = [...(bot.player.track && !bot.player.track.auto ? [bot.player.track] : []), ...bot.player.queue];
          if (!tracks.length) throw new HttpError(400, "The queue is empty");
          store.addTracks(list, tracks); syncDefaults(app);
          return { message: "Queue saved to " + list.name };
        }
      }
    }
  }
  throw new HttpError(404, "Not found");
}

export function startWebServer(app: App) {
  const { host, port, password } = app.config.web;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req, password)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="radiospeak", charset="UTF-8"' }).end("Login required");
      return;
    }
    const respondError = (err: unknown) => {
      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const asset = req.method === "GET" ? assets.get(url.pathname) : undefined;
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(asset.body);
        return;
      }
      route(app, req, url).then((data) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(data));
      }).catch(respondError);
    } catch (err) { respondError(err); }
  });
  server.on("error", (err) => log("error", "Web panel failed: " + err.message));
  server.listen(port, host, () => {
    log("info", "Web panel on http://" + (host === "0.0.0.0" ? "localhost" : host) + ":" + port);
    if (!password && !["127.0.0.1", "localhost", "::1"].includes(host)) log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
  return server;
}
