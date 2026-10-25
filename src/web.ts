import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { log, type App, type MusicBot } from "./bot.ts";
import { clampVolume } from "./config.ts";
import type { LoopMode, Track } from "./player.ts";
import { resolve } from "./ytdlp.ts";

const PAGE = readFileSync(join(import.meta.dirname, "web", "index.html"));

/** Chat replies use TeamSpeak BBCode; the panel shows plain text. */
const plain = (s: string) => s.replace(/\[\/?b\]/g, "");

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const trackJson = (t: Track) => ({
  url: t.url,
  title: t.title,
  duration: t.duration ?? null,
  requestedBy: t.requestedBy ?? null,
  auto: !!t.auto,
});

function botState(bot: MusicBot) {
  const pl = bot.player;
  return {
    name: bot.name,
    connected: bot.connected,
    channel: bot.channelName ?? null,
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
  // Requiring JSON keeps other sites from posting forms to the panel with the browser's saved login.
  if (!req.headers["content-type"]?.includes("application/json")) throw new HttpError(415, "Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Tracks posted back from search results; only http(s) links are accepted. */
function tracksFrom(v: unknown): Track[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t): Track | undefined => {
      const o = t as Record<string, unknown>;
      const url = str(o.url);
      if (!/^https?:\/\//i.test(url)) return undefined;
      const duration = Number(o.duration);
      return { url, title: str(o.title) || url, ...(duration > 0 ? { duration } : {}) };
    })
    .filter((t): t is Track => !!t);
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
      return bot.enqueue(tracksFrom(body.tracks), { requestedBy: "web", next: body.next === true });
    case "start":
      return pl.playIfIdle() ? "Playing." : "Nothing to play.";
    case "pause":
      pl.pause();
      return "Paused.";
    case "resume":
      pl.resume();
      return "Resumed.";
    case "skip":
      return pl.skip(Math.max(1, Number(body.count) || 1)) ? "Skipped." : "Nothing playing.";
    case "stop":
      return bot.stop();
    case "clear":
      pl.clearQueue();
      return "Queue cleared.";
    case "shuffle":
      pl.shuffle();
      return "Shuffled.";
    case "loop": {
      const mode = str(body.mode) as LoopMode;
      if (!["off", "one", "all"].includes(mode)) throw new HttpError(400, "Loop must be off, one or all");
      pl.setLoop(mode);
      return `Loop: ${mode}`;
    }
    case "volume":
      return bot.setVolume(clampVolume(Number(body.volume)));
    case "remove": {
      const removed = pl.removeAt(Number(body.position));
      if (!removed) throw new HttpError(404, "No such queue position");
      return `Removed ${removed.title}`;
    }
    case "radio":
      return bot.playRadio(str(body.url) || undefined);
  }
  throw new HttpError(404, "Unknown action");
}

async function route(app: App, req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const store = app.playlists;

  if (method === "GET" && url.pathname === "/api/state") {
    return {
      bots: app.bots.map(botState),
      playlists: store.all.map((p) => ({ name: p.name, tracks: p.tracks.map(trackJson) })),
    };
  }

  if (method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const { tracks } = await resolve(app.config.ytdlpPath, q, { maxItems: 10, results: 10 });
    return tracks.map(trackJson);
  }

  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && parts[3] && method === "POST") {
    const bot = app.bots.find((b) => b.name === parts[2]);
    if (!bot) throw new HttpError(404, "No such bot");
    return { message: plain(await botAction(app, bot, parts[3], await readJson(req))) };
  }

  if (url.pathname === "/api/playlists" && method === "POST") {
    const body = await readJson(req);
    try {
      return { message: `Created ${store.create(str(body.name)).name}` };
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  if (parts[0] === "api" && parts[1] === "playlists" && parts[2]) {
    const list = store.find(parts[2]);
    if (!list) throw new HttpError(404, "No such playlist");

    if (method === "DELETE" && parts.length === 3) {
      store.delete(list);
      return { message: `Deleted ${list.name}` };
    }
    if (method === "DELETE" && parts[3] === "tracks" && parts[4]) {
      const removed = store.removeTrack(list, Number(parts[4]));
      if (!removed) throw new HttpError(404, "No such song");
      return { message: `Removed ${removed.title}` };
    }
    if (method === "POST" && parts[3]) {
      const body = await readJson(req);
      const bot = app.bots.find((b) => b.name === str(body.bot)) ?? app.bots[0]!;
      switch (parts[3]) {
        case "add": {
          const input = str(body.input);
          let tracks = tracksFrom(body.tracks);
          if (input) tracks = (await resolve(app.config.ytdlpPath, input, { maxItems: app.config.maxPlaylistItems })).tracks;
          else if (body.current === true && bot.player.track) tracks = [bot.player.track];
          if (tracks.length === 0) throw new HttpError(400, "Nothing to add");
          const total = store.addTracks(list, tracks);
          return { message: `Added ${tracks.length === 1 ? tracks[0]!.title : `${tracks.length} songs`} to ${list.name} (${total})` };
        }
        case "play": {
          const tracks = [...list.tracks];
          if (tracks.length === 0) throw new HttpError(400, "Playlist is empty");
          if (body.shuffle === true) {
            for (let i = tracks.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
            }
          }
          return { message: plain(bot.enqueue(tracks, { requestedBy: "web", playlistName: list.name })) };
        }
        case "save": {
          const current = [...(bot.player.track && !bot.player.track.auto ? [bot.player.track] : []), ...bot.player.queue];
          if (current.length === 0) throw new HttpError(400, "The queue is empty");
          const total = store.addTracks(list, current);
          return { message: `Saved ${current.length} songs to ${list.name} (${total})` };
        }
      }
    }
  }

  throw new HttpError(404, "Not found");
}

export function startWebServer(app: App): void {
  const { host, port, password } = app.config.web;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req, password)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="radiospeak", charset="UTF-8"' }).end("Login required");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(PAGE);
      return;
    }
    route(app, req, url)
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(data));
      })
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
      });
  });

  server.on("error", (err) => log("error", `Web panel failed: ${err.message}`));
  server.listen(port, host, () => {
    log("info", `Web panel on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!password && !local) log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
}
