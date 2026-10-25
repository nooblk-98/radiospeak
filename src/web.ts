import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { log, type App, type RadioBot } from "./bot.ts";
import { clampVolume, type ScheduleEntry } from "./config.ts";
import { searchStations } from "./radiobrowser.ts";
import { ScheduleStore } from "./store.ts";

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

function botState(bot: RadioBot) {
  const r = bot.radio;
  return {
    name: bot.name,
    connected: bot.connected,
    clientID: bot.clientID ?? null,
    nickname: bot.client && bot.clientID !== undefined ? (bot.client.view.client(bot.clientID)?.nickname ?? null) : null,
    channel: bot.channelName ?? null,
    station: r.station ? { id: r.station.id, name: r.station.name } : null,
    song: bot.songTitle ?? null,
    track: r.track ? { title: r.track.title, url: r.track.url } : null,
    queue: r.queue.map((t) => ({ title: t.title, url: t.url })),
    volume: r.volume,
    paused: r.paused,
    listeners: bot.listeners().map((c) => ({ id: c.id, nickname: c.nickname })),
    channelClients: bot.channelID === undefined
      ? []
      : (bot.client?.view.clientsIn(bot.channelID) ?? []).map((c) => ({ id: c.id, nickname: c.nickname, type: c.type })),
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
    if (size > 64 * 1024) throw new HttpError(413, "Body too large");
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

async function route(app: App, req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && url.pathname === "/api/state") {
    return {
      bots: app.bots.map(botState),
      stations: app.stations.items,
      schedule: app.schedule.items.map((e) => ({ ...e, text: ScheduleStore.describe(e) })),
      timezone: app.config.timezone,
    };
  }

  if (method === "GET" && url.pathname === "/api/search") {
    return searchStations(url.searchParams.get("q") ?? "", 20);
  }

  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && method === "POST") {
    const bot = app.bots.find((b) => b.name === parts[2]);
    if (!bot) throw new HttpError(404, "No such bot");
    const body = await readJson(req);
    switch (parts[3]) {
      case "play": {
        const station = app.stations.find(str(body.station));
        if (!station) throw new HttpError(404, "Unknown station");
        return { message: plain(bot.playStation(station)) };
      }
      case "stop":
        return { message: plain(bot.stop()) };
      case "next":
        return { message: plain(bot.switchStation(1)) };
      case "prev":
        return { message: plain(bot.switchStation(-1)) };
      case "volume":
        return { message: plain(bot.setVolume(clampVolume(Number(body.volume)))) };
      case "queue": {
        const input = str(body.input);
        if (!input) throw new HttpError(400, "Missing link or search");
        return { message: plain(await bot.enqueue(input, "web")) };
      }
      case "skip":
        return { message: bot.radio.skip() ? "Skipped." : "No track playing." };
      case "clear":
        bot.radio.clearQueue();
        return { message: "Queue cleared." };
    }
    throw new HttpError(404, "Unknown action");
  }

  if (url.pathname === "/api/stations" && method === "POST") {
    const body = await readJson(req);
    const name = str(body.name);
    const stationUrl = str(body.url);
    if (!name || !/^https?:\/\//i.test(stationUrl)) throw new HttpError(400, "Name and http(s) URL required");
    const backupUrls = Array.isArray(body.backupUrls)
      ? body.backupUrls.map(str).filter((u) => /^https?:\/\//i.test(u))
      : [];
    const station = app.stations.add({
      id: app.stations.uniqueId(str(body.id) || name),
      name,
      url: stationUrl,
      ...(backupUrls.length ? { backupUrls } : {}),
    });
    return { message: `Added ${station.name}`, station };
  }

  if (parts[0] === "api" && parts[1] === "stations" && parts[2] && method === "DELETE") {
    const removed = app.stations.remove(parts[2]);
    if (!removed) throw new HttpError(404, "Unknown station");
    for (const b of app.bots) if (b.radio.station?.id === removed.id) b.radio.stop();
    return { message: `Removed ${removed.name}` };
  }

  if (url.pathname === "/api/schedule" && method === "POST") {
    const body = await readJson(req);
    const target = str(body.station);
    const station = target === "stop" ? "stop" : app.stations.find(target)?.id;
    if (!station) throw new HttpError(400, "Unknown station");
    const entry: ScheduleEntry = { time: str(body.time), station };
    if (Array.isArray(body.days) && body.days.length) entry.days = body.days.map(str);
    if (body.volume !== undefined && body.volume !== "") entry.volume = clampVolume(Number(body.volume));
    if (str(body.bot)) entry.bot = str(body.bot);
    try {
      return { message: `Added ${ScheduleStore.describe(app.schedule.add(entry))}` };
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  if (parts[0] === "api" && parts[1] === "schedule" && parts[2] && method === "DELETE") {
    const removed = app.schedule.removeAt(Number(parts[2]));
    if (!removed) throw new HttpError(404, "No such entry");
    return { message: `Removed ${ScheduleStore.describe(removed)}` };
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
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
      })
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
      });
  });

  server.on("error", (err) => log("error", `Web panel failed: ${err.message}`));
  server.listen(port, host, () => {
    log("info", `Web panel on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!password && !local) log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
}
