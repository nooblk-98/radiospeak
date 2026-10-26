import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { asChannelID } from "@honeybbq/teamspeak";
import { log, MusicBot, type App } from "./bot.ts";
import { clampVolume, instanceConfig, validateBotName, validateNickname } from "./config.ts";
import type { LoopMode, Track } from "./player.ts";
import { resolve, mediaStats } from "./ytdlp.ts";
import { ImportManager } from "./imports.ts";
import type { SavedPlaylist } from "./store.ts";
import { AuthError, WebAuth } from "./web-auth.ts";

const summaries = new WeakMap<SavedPlaylist, { key: string; value: object }>();
function summary(p: SavedPlaylist) {
  const key = p.version + "|" + p.collectionId;
  let entry = summaries.get(p);
  if (!entry || entry.key !== key) {
    entry = { key, value: { id: p.id, name: p.name, collectionId: p.collectionId, version: p.version,
      trackCount: p.tracks.length, totalDuration: p.tracks.reduce((sum,t) => sum + (t.duration ?? 0),0), coverTrack: p.tracks[0] ?? null } };
    summaries.set(p, entry);
  }
  return entry.value;
}
function imports(app: App) {
  return app.imports ??= new ImportManager(app.playlists, app.config.ytdlpPath, app.config.maxPlaylistItems);
}
/** Each instance runs its own audio pipeline, so panel-created ones are capped. */
const MAX_INSTANCES = 10;
const undo = new WeakMap<MusicBot, { token: string; track: Track; position: number; expires: number; order: string; current: string | undefined }>();
function stateFor(app: App) {
  return {
    uiVersion, authEnabled: app.config.web.password !== "",
    bots: app.bots.map((b) => ({ ...botState(b), removable: app.playlists.panelBots.includes(b.name) })), maxInstances: MAX_INSTANCES, collections: app.playlists.collections, defaults: app.playlists.defaults,
    radioStations: app.playlists.radioStations,
    favorites: app.playlists.favorites.map(trackJson), commandPrefix: app.config.commandPrefix,
    playlists: app.playlists.all.map(summary), imports: imports(app).all.map(job=>({ ...job, errors: job.errors.slice(0,20) })),
    system: stateForSystem(),
  };
}
function stateForSystem() { return { pid: process.pid, uptime: process.uptime(), memoryMB: Math.round(process.memoryUsage().rss / 1048576), media: mediaStats() }; }

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/api.js", ["api.js", "text/javascript"]],
  ["/volume.js", ["volume.js", "text/javascript"]],
  ["/components.js", ["components.js", "text/javascript"]],
].map(([path, [file, type]]) => [path, { body: readFileSync(join(import.meta.dirname, "web", file!)), type }]));
const loginPage = readFileSync(join(import.meta.dirname, "web", "login.html"));
// Give HTML and every imported module the same revision, including through caches.
const uiVersion = createHash("sha256").update([...assets].map(([path, asset]) => path + "\n" + asset.body.toString("utf8")).join("\n")).digest("hex").slice(0, 16);
for (const asset of assets.values()) {
  const body = asset.body.toString("utf8");
  asset.body = Buffer.from(asset.type === "text/html"
    ? body.replace(/(href|src)="\/(styles\.css|app\.js)"/g, `$1="/$2?v=${uiVersion}"`)
    : asset.type === "text/javascript"
      ? body.replace(/(\bfrom\s+['"])(\.\/[^'"]+\.js)(['"])/g, `$1$2?v=${uiVersion}$3`)
      : body);
}

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
const streamUrl = (s: unknown): string => {
  const url = httpUrl(s);
  if (!url) throw new HttpError(400, "Enter a valid HTTP or HTTPS stream URL");
  return url;
};
const trackJson =(t: Track) => ({ ...t, duration: t.duration ?? null, requestedBy: t.requestedBy ?? null, auto: !!t.auto });

function botState(bot: MusicBot) {
  const pl = bot.player;
  return {
    name: bot.name, nickname: bot.nickname, connected: bot.connected,
    channel: bot.channelName ?? null, channelId: bot.channelID?.toString() ?? null, homeChannel: bot.homeChannel || null,
    channels: bot.connected ? [...(bot.client?.view.channels.values() ?? [])].map((c) => ({ id: c.id.toString(), name: c.name })) : [],
    talkBlocked: bot.talkBlocked ?? null,
    track: pl.track ? trackJson(pl.track) : null, elapsed: pl.elapsed,
    queue: pl.queue.map(trackJson), radio: pl.radio ?? null, radioTitle: bot.radioTitle ?? null,
    defaultPlaylist: pl.defaultPlaylist, volume: pl.volume,
    userPaused: pl.userPaused, autoPaused: pl.autoPaused, loop: pl.loop,
    connectionPaused: pl.connectionPaused, lastDisconnect: bot.lastDisconnect ?? null,
    normalization: pl.normalization, shuffle: pl.shuffleEnabled, canGoBack: pl.canGoBack,
    listeners: bot.listeners().map((c) => c.nickname),
    health: bot.health,
  };
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

async function botAction(app: App, bot: MusicBot, action: string, body: Record<string, unknown>): Promise<string | { message: string; undoToken: string }> {
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
    case "prebuffer": pl.setPrebuffer(body.enabled === true); return "Next-track prebuffering " + (body.enabled ? "enabled." : "disabled.");
    case "nickname":
      await bot.setNickname(str(body.nickname));
      return "Bot name saved.";
    case "remove": {
      checkOrder(pl.queue, body);
      const removed = pl.removeAt(Number(body.position));
      if (!removed) throw new HttpError(404, "No such queue position");
      const token = randomUUID();
      undo.set(bot, { token, track: removed, position: Number(body.position), expires: Date.now() + 60_000,
        order: JSON.stringify(pl.queue.map(t=>t.url)), current: pl.track?.url });
      return { message: "Removed " + removed.title, undoToken: token };
    }
    case "undo": {
      const saved = undo.get(bot);
      if (!saved || saved.token !== body.token || saved.expires < Date.now()) throw new HttpError(409, "Undo expired");
      if (saved.order !== JSON.stringify(pl.queue.map(t=>t.url)) || saved.current !== pl.track?.url) throw new HttpError(409, "The queue changed. Undo is no longer available.");
      if (!pl.insertAt(saved.track, saved.position)) throw new HttpError(409, "Cannot restore this position");
      undo.delete(bot);
      return "Track restored to the queue.";
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
      await bot.moveTo(asChannelID(channel.id), true);
      return "Moved to " + channel.name + ". The bot returns here after reconnecting.";
    }
    case "default": {
      const list = body.playlistId === null ? null : app.playlists.find(str(body.playlistId));
      if (list === undefined) throw new HttpError(404, "Playlist not found");
      app.playlists.setDefault(bot.name, list);
      syncDefaults(app);
      return list ? list.name + " is now the default idle playlist." : "Idle playlist disabled.";
    }
    case "radio": {
      if (body.stationId !== undefined) {
        const station = app.playlists.radioStations.find((r) => r.id === str(body.stationId));
        if (!station) throw new HttpError(404, "Radio station not found");
        return bot.playRadio(station.url, station.name);
      }
      const url = str(body.url);
      if (url && !httpUrl(url)) throw new HttpError(400, "Enter a valid HTTP or HTTPS stream URL");
      return bot.playRadio(url || undefined);
    }
  }
  throw new HttpError(404, "Unknown action");
}

export async function route(app: App, req: IncomingMessage, url: URL, signal?: AbortSignal): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const store = app.playlists;
  if (method === "GET" && url.pathname === "/api/state") {
    return stateFor(app);
  }
  if (method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q || q.length > 1000) throw new HttpError(400, "Enter a search or public media URL (up to 1,000 characters)");
    const source = url.searchParams.get("source") === "soundcloud" ? "soundcloud" : "youtube";
    return (await resolve(app.config.ytdlpPath, q, { maxItems: 10, results: 10, source, signal })).tracks.map(trackJson);
  }
  if (url.pathname === "/api/imports" && method === "POST") {
    const body = await readJson(req);
    return { message: "Import started.", job: imports(app).start(str(body.playlistId), str(body.input), body.skipDuplicates !== false) };
  }
  if (parts[0] === "api" && parts[1] === "imports" && parts[2]) {
    const job = imports(app).get(parts[2]);
    if (!job) throw new HttpError(404, "Import not found");
    if (method === "POST" && parts[3] === "cancel") { await readJson(req); imports(app).cancel(job.id); }
    return { job };
  }
  if (method === "POST" && url.pathname === "/api/favorites") {
    const [track] = tracksFrom([(await readJson(req)).track]);
    if (!track) throw new HttpError(400, "No track to save");
    return { message: store.toggleFavorite(track) ? "Saved to favorites." : "Removed from favorites." };
  }
  if (url.pathname === "/api/bots" && method === "POST") {
    const body = await readJson(req);
    const name = validateBotName(str(body.name));
    if (app.bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "An instance with that ID already exists");
    if (app.bots.length >= MAX_INSTANCES) throw new HttpError(400, `This server runs at most ${MAX_INSTANCES} instances`);
    const nickname = validateNickname(str(body.nickname) || name);
    // Every bot is on the same server, so a connected one can name the chosen channel.
    const channelId = str(body.channelId);
    const channel = channelId ? app.bots.map((b) => b.channelPathById(channelId)).find(Boolean) : undefined;
    if (channelId && !channel) throw new HttpError(404, "Channel not found");
    app.playlists.addPanelBot(name, nickname, channel);
    const bot = new MusicBot(app, instanceConfig(app.config.bots[0]!, name), app.bots.length);
    app.bots.push(bot);
    bot.start().catch((err: unknown) => bot.log("error", `Bot failed: ${err instanceof Error ? err.message : String(err)}`));
    return { message: nickname + " is starting and joins TeamSpeak in a few seconds.", bot: name };
  }
  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && parts.length === 3 && method === "DELETE") {
    const bot = selectedBot(app, parts[2]);
    if (!app.playlists.panelBots.includes(bot.name)) throw new HttpError(400, "This instance comes from the server configuration. Remove it there.");
    await readJson(req);
    const nickname = bot.nickname;
    await bot.shutdown();
    app.bots.splice(app.bots.indexOf(bot), 1);
    app.playlists.removePanelBot(bot.name);
    app.playback?.delete(bot.name);
    return { message: nickname + " was removed." };
  }
  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && parts[3] && method === "POST") {
    const result = await botAction(app, selectedBot(app, parts[2]), parts[3], await readJson(req));
    return typeof result === "string" ? { message: plain(result) } : result;
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
  if (parts[0] === "api" && parts[1] === "radio-stations") {
    if (method === "POST" && parts.length === 2) {
      const body = await readJson(req);
      const station = store.createStation(str(body.name), streamUrl(body.url));
      return { message: station.name + " added to your stations.", station };
    }
    if (parts[2] && method === "PATCH") {
      const body = await readJson(req);
      store.updateStation(parts[2], str(body.name), streamUrl(body.url));
      return { message: "Radio station updated." };
    }
    if (parts[2] && method === "DELETE") {
      store.deleteStation(parts[2]);
      return { message: "Radio station deleted." };
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
    if (method === "GET" && parts.length === 3) {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 50)));
      return { ...list, tracks: list.tracks.slice(offset, offset + limit).map(trackJson), offset, total: list.tracks.length };
    }
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
      const body = await readJson(req);
      if (body.expectedVersion !== undefined && body.expectedVersion !== list.version) throw new HttpError(409, "The playlist changed. Please try again.");
      checkOrder(list.tracks, body);
      const removed = store.removeTrack(list, Number(parts[4]));
      if (!removed) throw new HttpError(404, "No such song");
      syncDefaults(app);
      return { message: "Removed " + removed.title };
    }
    if (method === "POST" && parts[3]) {
      const body = await readJson(req);
      if (body.expectedVersion !== undefined && body.expectedVersion !== list.version) throw new HttpError(409, "The playlist changed. Please try again.");
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
        case "play-now":
          if (!list.tracks.length) throw new HttpError(400, "Playlist is empty");
          bot.player.playNow(list.tracks.map((t) => ({ ...t, requestedBy: "web" })), true);
          return { message: "Playing " + list.name + " now. It replaced the queue." };
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
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const peers = new Set<ServerResponse>();
  let previous = "", sequence = 0;
  const send = (res: ServerResponse, event: string, payload: unknown) => {
    if (res.destroyed || res.writableLength > 256 * 1024) { peers.delete(res); res.end(); return; }
    res.write("id: " + (++sequence) + "\nevent: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n");
  };
  const withHealth = () => ({ ...stateFor(app), system: { ...stateForSystem(), eventLoopLagMs: Number.isFinite(lag.mean) ? Math.round(lag.mean / 1e6) : 0 } });
  const timer = setInterval(() => {
    if (!peers.size) return;
    const state = withHealth();
    const key = JSON.stringify({ ...state, system: undefined, bots: state.bots.map(b=>({
      ...b, elapsed: undefined, health: { prebufferEnabled: b.health.prebufferEnabled, retrying: b.health.retrying },
    })) });
    if (key !== previous) {
      previous = key;
      for (const peer of peers) send(peer, "state", state);
    } else {
      const progress = { uiVersion, bots: state.bots.map(b=>({ name: b.name, elapsed: b.elapsed, health: b.health })), system: state.system };
      for (const peer of peers) send(peer, "playback_progress", progress);
    }
  }, 1000).unref();
  const auth = new WebAuth(password);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respondError = (err: unknown) => {
      if (res.destroyed || res.headersSent) return;
      const status = err instanceof HttpError || err instanceof AuthError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
    };
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(data));
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const api = url.pathname.startsWith("/api/");
      if (url.pathname === "/login" && req.method === "GET") {
        if (!auth.authorized(req, false)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" }).end(loginPage);
        } else res.writeHead(302, { Location: "/" }).end();
        return;
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        readJson(req).then((body) => {
          json({ message: "Signed in." }, { "Set-Cookie": auth.login(req, typeof body.password === "string" ? body.password : "", body.remember === true) });
        }).catch(respondError);
        return;
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        json({ message: "Signed out." }, { "Set-Cookie": auth.logout(req) });
        return;
      }
      if (!auth.authorized(req, api)) {
        // Pages go to the login form; API calls get JSON (no Basic challenge, so browsers show no popup).
        if (!api && req.method === "GET") res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }).end();
        else res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Sign in to continue." }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        res.setTimeout(0);
        peers.add(res);
        send(res, "state", withHealth());
        res.on("close", () => peers.delete(res));
        return;
      }
      const asset = req.method === "GET" ? assets.get(url.pathname) : undefined;
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(asset.body);
        return;
      }
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(new Error("Request cancelled")); };
      res.on("close", onClose);
      route(app, req, url, controller.signal).then((data) => {
        if (!res.destroyed) json(data);
      }).catch(respondError).finally(() => res.off("close", onClose));
    } catch (err) { respondError(err); }
  });
  server.on("error", (err) => log("error", "Web panel failed: " + err.message));
  server.on("close", () => { clearInterval(timer); lag.disable(); imports(app).close(); for (const peer of peers) peer.end(); peers.clear(); });
  server.listen(port, host, () => {
    log("info", "Web panel on http://" + (host === "0.0.0.0" ? "localhost" : host) + ":" + port);
    if (!password && !["127.0.0.1", "localhost", "::1"].includes(host)) log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
  return server;
}
