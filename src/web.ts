import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { asChannelID } from "@honeybbq/teamspeak";
import { log, MusicBot, type App } from "./bot.ts";
import { clampVolume, instanceConfig, validateBotName, validateNickname } from "./config.ts";
import type { LoopMode, Track } from "./player.ts";
import { resolve, mediaStats, playlistId } from "./ytdlp.ts";
import { ImportManager } from "./imports.ts";
import type { SavedPlaylist } from "./store.ts";
import { AuthError, WebAuth } from "./web-auth.ts";
import { owner, settingsFrom, type Viewer, type Role, type PlaylistSchedule } from "./policies.ts";
import { createAccount } from "./accounts.ts";
import { sourceRevision } from "./build-info.ts";
import { trackKey } from "./track-key.ts";
import { Operations, validateDeploymentPolicy } from "./operations.ts";

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
/** Search results come in pages of 10, up to 50 in total. */
const SEARCH_PAGE_SIZE = 10;
const SEARCH_PAGES = 5;
const undo = new WeakMap<MusicBot, { token: string; track: Track; position: number; expires: number; order: string; current: string | undefined }>();
function stateFor(app: App) {
  return {
    uiVersion, authEnabled: app.config.web.password !== "",
    bots: app.bots.map((b) => ({ ...botState(b), removable: app.playlists.panelBots.includes(b.name), welcomes: app.playlists.welcomes(b.name) })), maxInstances: MAX_INSTANCES, collections: app.playlists.collections, defaults: app.playlists.defaults,
    radioStations: app.playlists.radioStations,
    schedules: app.playlists.schedules,
    favorites: app.playlists.favorites.map(trackJson), commandPrefix: app.config.commandPrefix,
    playlists: app.playlists.all.map(summary), imports: imports(app).all.map(job=>({ ...job, errors: job.errors.slice(0,20), failedIndices: undefined, input: undefined })),
    system: stateForSystem(),
    deployment: app.operations?.status.deployment,
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
  ["/operations.js", ["operations.js", "text/javascript"]],
  ["/notifications.js", ["notifications.js", "text/javascript"]],
  ["/enqueue.js", ["enqueue.js", "text/javascript"]],
  ["/management.js", ["management.js", "text/javascript"]],
].map(([path, [file, type]]) => [path, { body: readFileSync(join(import.meta.dirname, "web", file!)), type }]));
const loginPage = readFileSync(join(import.meta.dirname, "web", "login.html"));
// Give HTML and every imported module the same revision, including through caches.
const uiVersion = sourceRevision.slice(0,16);
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
const trackJson =(t: Track) => { const { importKey, ...track } = t; return { ...track, duration: t.duration ?? null, requestedBy: t.requestedBy ?? null, auto: !!t.auto }; };

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
    settings: bot.settings, activeSchedule: bot.activeSchedule ?? null, votes: bot.votes,
    historyVersion: bot.historyVersion,
  };
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.includes("application/json")) throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Body too large");
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
  for (const bot of app.bots) bot.syncLibrary();
}
function selectedBot(app: App, value: unknown): MusicBot {
  const bot = value ? app.bots.find((b) => b.name === str(value)) : app.bots[0];
  if (!bot) throw new HttpError(404, "No such bot");
  return bot;
}

async function botAction(app: App, bot: MusicBot, action: string, body: Record<string, unknown>, viewer: Viewer): Promise<string | { message: string; undoToken?: string; added?: number }> {
  const pl = bot.player;
  switch (action) {
    case "play": {
      const input = str(body.input);
      if (!input) throw new HttpError(400, "Enter a link or search words");
      if (viewer.role === "listener" && body.next) throw new HttpError(403,"A DJ can choose what plays next");
      return bot.play(input, { requestedBy: viewer.username, requesterId: viewer.id, privileged: viewer.role !== "listener", next: body.next === true, wholePlaylist: body.all === true });
    }
    case "enqueue":
    case "play-now": {
      let tracks = tracksFrom(body.tracks);
      if (!tracks.length) throw new HttpError(400, "No playable tracks");
      if (action === "play-now") {
        pl.playNow(tracks.map((t) => ({ ...t, requestedBy: "web" })));
        return "Playing now.";
      }
      if (viewer.role === "listener" && body.next) throw new HttpError(403,"A DJ can choose what plays next");
      if(body.unique===true) {
        const seen=new Set([...(pl.track?[pl.track]:[]),...pl.queue].map(t=>trackKey(t.url)));
        tracks=tracks.filter(track=>{const key=trackKey(track.url);if(seen.has(key))return false;seen.add(key);return true;});
        if(!tracks.length)return {message:"Already playing or queued.",added:0};
      }
      const message=bot.enqueue(tracks, { requestedBy: viewer.username, requesterId: viewer.id, privileged: viewer.role !== "listener", next: body.next === true });
      return body.unique===true?{message:plain(message),added:tracks.length}:message;
    }
    case "start": return pl.playIfIdle() ? "Playing." : "Nothing to play.";
    case "vote-skip": return bot.voteSkip(viewer.id);
    case "settings": {
      const value = body.settings as Parameters<typeof settingsFrom>[0];
      if (!value || typeof value !== "object") throw new HttpError(400,"Settings are required");
      app.playlists.setSettings(bot.name,value); bot.syncLibrary(); return "Bot performance and request settings saved.";
    }
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
    case "welcome":
      app.playlists.setWelcomes(bot.name, body.enabled === true);
      return body.enabled === true ? "New listeners get the command list in channel chat." : "Join greetings turned off.";
    case "nickname":
      await bot.setNickname(str(body.nickname));
      return "Bot name saved.";
    case "remove": {
      checkOrder(pl.queue, body);
      if (viewer.role === "listener" && pl.queue[Number(body.position)-1]?.requesterId !== viewer.id) throw new HttpError(403,"You can only remove your own requests");
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
      if (viewer.role === "listener" && saved.track.requesterId !== viewer.id) throw new HttpError(403,"This was another listener's request");
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

export async function route(app: App, req: IncomingMessage, url: URL, signal?: AbortSignal, viewer: Viewer = owner): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const store = app.playlists;
  if (["transfer","operations","audit"].includes(parts[1] ?? "")) {
    if(viewer.role!=="admin")throw new HttpError(403,"Administrator access required");
    if(parts[1]==="audit" && method==="GET")return app.operations?.entries(Math.max(0,Number(url.searchParams.get("offset"))||0));
    if(parts[1]==="operations") {
      if(method==="POST") { const body=await readJson(req); if(body.cancel===true)app.operations!.cancel();else app.operations!.setPolicy(body.policy as Parameters<Operations["setPolicy"]>[0]); }
      return app.operations!.status;
    }
    if(parts[1]==="transfer") {
      if(method==="GET")return {...store.exportLibrary(),deploymentPolicy:app.operations!.status.policy,players:Object.fromEntries(app.bots.map(b=>[b.name,{volume:b.player.volume,normalization:b.player.normalization,loop:b.player.loop,shuffle:b.player.shuffleEnabled,prebuffer:b.player.health.prebufferEnabled}]))};
      if(method==="POST") {
        const body=await readJson(req,16*1024*1024);
        const archive=body.archive as {players?:Record<string,{volume:number;normalization:boolean;loop:LoopMode;shuffle:boolean;prebuffer:boolean}>;deploymentPolicy?:Parameters<Operations["setPolicy"]>[0]};
        if(body.applySettings===true && archive?.players!==undefined) {
          if(!archive.players || typeof archive.players!=="object" || Array.isArray(archive.players))throw new HttpError(400,"Invalid player preferences");
          for(const settings of Object.values(archive.players))if(!settings || !Number.isInteger(settings.volume) || settings.volume<0 || settings.volume>100 || !["off","all","one"].includes(settings.loop) || ![settings.normalization,settings.shuffle,settings.prebuffer].every(v=>typeof v==="boolean"))throw new HttpError(400,"Invalid player preferences");
        }
        if(body.applySettings===true && archive?.deploymentPolicy)validateDeploymentPolicy(archive.deploymentPolicy);
        if(imports(app).active)throw new HttpError(409,"Wait for active playlist imports to finish before importing settings");
        const result=store.importLibrary(body.archive,body.applySettings===true,app.bots.map(b=>b.name),body.preview===true);
        if(body.preview!==true) {
          syncDefaults(app);
          if(body.applySettings===true) {
            if(archive.deploymentPolicy)app.operations!.setPolicy(archive.deploymentPolicy);
            for(const bot of app.bots) {
              const nickname=store.nicknameFor(bot.name);if(nickname && nickname!==bot.nickname)void bot.setNickname(nickname).catch(()=>{});
              const settings=archive.players?.[bot.name];
              if(settings){bot.player.setVolume(settings.volume);bot.player.setLoop(settings.loop);if(bot.player.shuffleEnabled!==settings.shuffle)bot.player.setShuffle(settings.shuffle);if(bot.player.normalization!==settings.normalization)bot.player.setNormalization(settings.normalization);bot.player.setPrebuffer(settings.prebuffer);}
            }
          }
          await app.playback?.flush();
        }
        return {...result,message:body.preview===true?"Export validated. Review the counts before importing.":"Settings and playlists imported."};
      }
    }
    throw new HttpError(405,"Unsupported operation");
  }
  if (method !== "GET" && viewer.role !== "admin") {
    if (["access","accounts"].includes(parts[1] ?? "") || (parts[1] === "bots" && parts.length <= 3)) throw new HttpError(403,"An administrator manages accounts and instances");
    if (viewer.role === "listener") {
      const allowed = parts[1] === "bots" && ["enqueue","play","vote-skip","remove","undo"].includes(parts[3] ?? "")
        || parts[1] === "playlists" && parts[3] === "play";
      if (!allowed) throw new HttpError(403,"A DJ manages playback and playlists");
    }
  }
  if (method === "GET" && url.pathname === "/api/state") {
    return { ...stateFor(app), viewer };
  }
  if (parts[1] === "bots" && parts[2] && parts[3] === "history" && method === "GET") {
    const bot = selectedBot(app,parts[2]);
    return { entries: store.historyFor(bot.name).map(h => ({ ...h, track: trackJson(h.track) })) };
  }
  if (parts[1] === "access") {
    if (viewer.role !== "admin") throw new HttpError(403,"Administrator access required");
    if (method === "POST") store.setChatAccess((await readJson(req)).chatAccess as Parameters<typeof store.setChatAccess>[0]);
    return { accounts: store.accounts.map(({username,role}) => ({username,role})), chatAccess: store.chatAccess };
  }
  if (parts[1] === "accounts") {
    if (viewer.role !== "admin" || !app.config.web.password) throw new HttpError(403,"Set a panel administrator password before managing accounts");
    if (method === "POST") {
      const body = await readJson(req), username = str(body.username).toLowerCase(), role = str(body.role) as Role;
      const current = store.accounts.find(a => a.username === username);
      if (str(body.password)) store.saveAccount(await createAccount(username,String(body.password),role));
      else if (current) store.saveAccount({ ...current, role, version: randomUUID() });
      else throw new HttpError(400,"A new account needs a password");
      return { message: "Account saved. Existing sessions for it have been signed out." };
    }
    if (method === "DELETE" && parts[2]) { await readJson(req); store.deleteAccount(parts[2]); return { message: "Account removed." }; }
  }
  if (parts[1] === "schedules") {
    if (method === "DELETE" && parts[2]) { await readJson(req); store.deleteSchedule(parts[2]); syncDefaults(app); return { message: "Schedule removed." }; }
    if (method === "POST" || method === "PATCH") {
      const body = await readJson(req); selectedBot(app,body.bot);
      const value = { bot: str(body.bot), playlistId: str(body.playlistId), timezone: str(body.timezone) || "Asia/Colombo", days: body.days, start: str(body.start), end: str(body.end), enabled: body.enabled === true } as Omit<PlaylistSchedule,"id">;
      const schedule = store.saveSchedule(value,parts[2]); syncDefaults(app); return { message: "Schedule saved.", schedule };
    }
  }
  if (method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q || q.length > 1000) throw new HttpError(400, "Enter a search or public media URL (up to 1,000 characters)");
    const source = url.searchParams.get("source") === "soundcloud" ? "soundcloud" : "youtube";
    // Pages of SEARCH_PAGE_SIZE; later pages may simply come back empty.
    const page = Math.min(SEARCH_PAGES, Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)));
    const startIndex = (page - 1) * SEARCH_PAGE_SIZE + 1;
    if (url.searchParams.get("type") === "playlists") {
      if (source !== "youtube") throw new HttpError(400, "Playlist search is available for YouTube only");
      // YouTube's own results page, filtered to playlists (sp=EgIQAw==).
      const results = new URL("https://www.youtube.com/results");
      results.searchParams.set("search_query", q);
      results.searchParams.set("sp", "EgIQAw==");
      try {
        const found = await resolve(app.config.ytdlpPath, results.href, { maxItems: SEARCH_PAGE_SIZE, startIndex, partial: true, signal });
        return found.tracks.filter((t) => playlistId(t.url) && !new URL(t.url).searchParams.has("v")).map(trackJson);
      } catch (err) {
        if (err instanceof Error && /^Nothing playable/.test(err.message)) return [];
        throw err;
      }
    }
    return (await resolve(app.config.ytdlpPath, q, { maxItems: SEARCH_PAGE_SIZE, results: page * SEARCH_PAGE_SIZE, startIndex, partial: page > 1, source, signal })).tracks.map(trackJson);
  }
  if (url.pathname === "/api/imports/preview" && method === "POST") return imports(app).preview(str((await readJson(req)).input),signal);
  if (url.pathname === "/api/imports" && method === "POST") {
    const body = await readJson(req);
    return { message: "Import started.", job: imports(app).start(str(body.playlistId), str(body.input), body.skipDuplicates !== false) };
  }
  if (parts[0] === "api" && parts[1] === "imports" && parts[2]) {
    const job = imports(app).get(parts[2]);
    if (!job) throw new HttpError(404, "Import not found");
    if (method === "POST" && parts[3] === "cancel") { await readJson(req); imports(app).cancel(job.id); }
    if (method === "POST" && ["resume","retry"].includes(parts[3] ?? "")) { await readJson(req); imports(app).resume(job.id,parts[3] === "retry"); }
    if (method === "DELETE") { await readJson(req); imports(app).remove(job.id); return { message: "Import removed." }; }
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
    const result = await botAction(app, selectedBot(app, parts[2]), parts[3], await readJson(req),viewer);
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
      const matching=store.matchTracks(list,url.searchParams.get("q") ?? "",url.searchParams.get("duplicates")==="true"),page=matching.slice(offset,offset+limit);
      return { ...list, tracks: page.map(t=>trackJson(t.track)), positions:page.map(t=>t.index), offset, total: matching.length, trackCount:list.tracks.length };
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
        case "bulk": {
          if(body.expectedVersion!==list.version)throw new HttpError(409,"The playlist changed. Refresh and select the tracks again.");
          const count=store.bulkTracks(list,body as Parameters<typeof store.bulkTracks>[1]);syncDefaults(app);
          return {message:`Updated ${count} track(s).`};
        }
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
          return { message: plain(bot.enqueue(list.tracks.map((t) => ({ ...t, playlistId: list.id })), { requestedBy: viewer.username, requesterId: viewer.id, privileged: viewer.role !== "listener", playlistName: list.name })) };
        case "play-now":
          if (!list.tracks.length) throw new HttpError(400, "Playlist is empty");
          bot.player.playNow(list.tracks.map((t) => ({ ...t, requestedBy: "web", playlistId: list.id })), true);
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
  app.operations ??= new Operations(app);
  const { host, port, password } = app.config.web;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const peers = new Set<ServerResponse>();
  const sessions = new Map<ServerResponse, { req: IncomingMessage; viewer: Viewer }>();
  const auth = new WebAuth(password,() => app.playlists.accounts);
  let previous = "", sequence = 0;
  const write = (res: ServerResponse, frame: string) => {
    if (res.destroyed || res.writableLength > 256 * 1024) { peers.delete(res); res.end(); return; }
    res.write(frame);
  };
  const frame = (event: string, payload: unknown) => "id: " + (++sequence) + "\nevent: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  const system = () => ({ ...stateForSystem(), libraryError: app.playlists.persistenceError,
    eventLoopLagMs: Number.isFinite(lag.mean) ? Math.round(lag.mean / 1e6) : 0,
    eventLoopP99Ms: Math.round(lag.percentile(99) / 1e6) });
  const withHealth = () => ({ ...stateFor(app), system: system() });
  const revision = () => [app.playlists.revision,imports(app).revision,app.operations?.revision,...app.bots.map(b => b.name+":"+b.revision)].join("|");
  const timer = setInterval(() => {
    if (!peers.size) return;
    for (const [peer,session] of sessions) {
      const viewer = auth.viewer(session.req,true);
      if (!viewer || viewer.role !== session.viewer.role) { peers.delete(peer); sessions.delete(peer); peer.end(); }
    }
    if (!peers.size) return;
    const key = revision();
    if (key !== previous) {
      previous = key;
      const message = frame("state",withHealth());
      for (const peer of peers) write(peer,message);
    } else {
      const progress = { uiVersion, bots: app.bots.map(b=>({ name: b.name, elapsed: b.player.elapsed, health: b.health })), system: system() };
      const message = frame("playback_progress",progress);
      for (const peer of peers) write(peer,message);
    }
    lag.reset();
  }, 1000).unref();
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
      if (url.pathname === "/healthz" && req.method === "GET") {
        const ready = app.bots.every(b => b.connected) && !app.playlists.persistenceError && !app.playback?.status.error;
        json({ ok: true, ready, sourceRevision, uiVersion, bots: app.bots.length, activeImports: imports(app).active }); return;
      }
      const api = url.pathname.startsWith("/api/");
      if(url.pathname==="/api/deployments" && req.method==="POST") {
        if(!app.operations!.authorized(req.headers.authorization))throw new HttpError(401,"Deployment token required");
        readJson(req).then(async body=>{const status=app.operations!.queue(str(body.revision),str(body.webhook),body.force===true);await app.operations!.flush();json(status);}).catch(respondError);return;
      }
      if (url.pathname === "/login" && req.method === "GET") {
        if (!auth.authorized(req, false)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" }).end(loginPage);
        } else res.writeHead(302, { Location: "/" }).end();
        return;
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        readJson(req).then(async (body) => {
          json({ message: "Signed in." }, { "Set-Cookie": await auth.login(req, typeof body.password === "string" ? body.password : "", body.remember === true, str(body.username) || "owner") });
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
        const viewer = auth.viewer(req,true)!;
        sessions.set(res,{ req, viewer });
        write(res,frame("state",{ ...withHealth(), viewer }));
        res.on("close", () => { peers.delete(res); sessions.delete(res); });
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
      route(app, req, url, controller.signal,auth.viewer(req,api)).then(async (data) => {
        if (req.method !== "GET") {
          await app.playlists.flush();
          if(!["/api/search","/api/imports/preview"].includes(url.pathname))app.operations!.audit(auth.viewer(req,api)!.username,req.method ?? "POST",url.pathname);
          await app.operations!.flush();
        }
        if (!res.destroyed) json(data);
      }).catch(respondError).finally(() => res.off("close", onClose));
    } catch (err) { respondError(err); }
  });
  server.on("error", (err) => log("error", "Web panel failed: " + err.message));
  server.on("close", () => { clearInterval(timer); lag.disable(); imports(app).close(); app.operations?.close(); for (const peer of peers) peer.end(); peers.clear(); sessions.clear(); });
  server.listen(port, host, () => {
    log("info", "Web panel on http://" + (host === "0.0.0.0" ? "localhost" : host) + ":" + port);
    if (!password && !["127.0.0.1", "localhost", "::1"].includes(host)) log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
  return server;
}
