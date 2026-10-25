import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Codec,
  ServerError,
  TextMessageTarget,
  sendChannelMessage,
  sendPrivateMessage,
  sendServerMessage,
  type TextMessageEvent,
} from "@honeybbq/teamspeak";
import { Client, generateIdentity, parseIdentity, type Identity } from "@honeybbq/teamspeak/client";
import { clampVolume, loadConfig, loadStations, saveStations, type Station } from "./config.ts";
import { RadioPlayer } from "./radio.ts";

function log(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

const config = loadConfig();
let stations = loadStations();
let client: Client | undefined;
let shuttingDown = false;
let voiceFailing = false;
let framesSent = 0;

async function loadIdentity(): Promise<Identity> {
  if (existsSync(config.identityFile)) {
    return parseIdentity(readFileSync(config.identityFile, "utf8").trim());
  }
  log("info", `Generating new identity (level ${config.identityLevel}), this can take a moment...`);
  const identity = await generateIdentity(config.identityLevel);
  writeFileSync(config.identityFile, identity.export() + "\n");
  log("info", `Saved identity to ${config.identityFile}`);
  return identity;
}

const radio = new RadioPlayer({
  ffmpegPath: config.ffmpegPath,
  bitrateKbps: config.bitrateKbps,
  volume: config.volume,
  log,
  sendFrame(frame) {
    try {
      client?.sendVoice(frame, Codec.OpusMusic);
      if (frame.length > 0) framesSent++;
      if (voiceFailing) log("info", "Voice sending resumed");
      voiceFailing = false;
    } catch (err) {
      // Not connected (yet / while reconnecting): drop the frame, the radio keeps running.
      if (!voiceFailing) log("warn", `Voice send failed, dropping audio: ${err instanceof Error ? err.message : String(err)}`);
      voiceFailing = true;
    }
  },
});

function findStation(query: string): Station | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const n = Number(q);
  if (Number.isInteger(n) && n >= 1 && n <= stations.length) return stations[n - 1];
  return (
    stations.find((s) => s.id.toLowerCase() === q) ??
    stations.find((s) => s.name.toLowerCase() === q) ??
    stations.find((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
  );
}

function stationIndex(station: Station | undefined): number {
  return station ? stations.findIndex((s) => s.id === station.id) : -1;
}

function isAdmin(msg: TextMessageEvent): boolean {
  return config.admins.length === 0 || config.admins.includes(msg.invokerUID);
}

function listText(): string {
  if (stations.length === 0) return "No stations yet. Add one with !add <id> <url> [name]";
  const current = radio.station?.id;
  return (
    "Stations:\n" +
    stations.map((s, i) => `${i + 1}. [b]${s.name}[/b] (${s.id})${s.id === current ? "  ◀ playing" : ""}`).join("\n")
  );
}

const helpText = [
  "[b]FM Radio commands[/b]",
  "!list — show stations",
  "!play [number|id|name] — play a station (no argument: resume)",
  "!stop — stop playing",
  "!next / !prev — switch station",
  "!vol [0-100] — show or set volume",
  "!np — what is playing",
  "!add <id> <url> [name] — add a station",
  "!remove <id> — remove a station",
].join("\n");

function playStation(station: Station): string {
  radio.play(station);
  return `Now playing: [b]${station.name}[/b]`;
}

async function handleCommand(msg: TextMessageEvent): Promise<string | undefined> {
  const text = msg.message.trim();
  if (!text.startsWith(config.commandPrefix)) return undefined;
  const [rawCmd = "", ...rest] = text.slice(config.commandPrefix.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(" ");

  switch (cmd) {
    case "help":
    case "h":
      return helpText;

    case "list":
    case "stations":
    case "ls":
      return listText();

    case "play":
    case "p": {
      if (!arg) {
        const station = radio.station ?? findStation(config.defaultStation) ?? stations[0];
        return station ? playStation(station) : "No stations configured.";
      }
      const station = findStation(arg);
      return station ? playStation(station) : `Unknown station "${arg}". Use !list.`;
    }

    case "stop":
      if (!radio.isPlaying) return "Not playing.";
      radio.stop();
      return "Stopped.";

    case "next":
    case "prev": {
      if (stations.length === 0) return "No stations configured.";
      const step = cmd === "next" ? 1 : -1;
      const i = stationIndex(radio.station);
      const nextIndex = i < 0 ? 0 : (i + step + stations.length) % stations.length;
      return playStation(stations[nextIndex]!);
    }

    case "vol":
    case "volume": {
      if (!arg) return `Volume: ${radio.volume}`;
      const v = Number(arg);
      if (!Number.isFinite(v)) return "Usage: !vol 0-100";
      radio.setVolume(clampVolume(v));
      return `Volume set to ${radio.volume}`;
    }

    case "np":
    case "status":
      return radio.station
        ? `Playing: [b]${radio.station.name}[/b] — volume ${radio.volume}`
        : "Not playing. Use !play";

    case "add": {
      if (!isAdmin(msg)) return "You are not allowed to add stations.";
      const [id, url, ...nameParts] = rest;
      // TeamSpeak chat wraps links as [URL]...[/URL]; strip that.
      const cleanUrl = url?.replace(/^\[url\]/i, "").replace(/\[\/url\]$/i, "");
      if (!id || !cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return "Usage: !add <id> <http(s)-url> [name]";
      if (stations.some((s) => s.id.toLowerCase() === id.toLowerCase())) return `Station id "${id}" already exists.`;
      const station: Station = { id, name: nameParts.join(" ") || id, url: cleanUrl };
      stations.push(station);
      saveStations(stations);
      return `Added ${stations.length}. [b]${station.name}[/b]`;
    }

    case "remove":
    case "rm": {
      if (!isAdmin(msg)) return "You are not allowed to remove stations.";
      const station = findStation(arg);
      if (!station) return `Unknown station "${arg}".`;
      stations = stations.filter((s) => s.id !== station.id);
      saveStations(stations);
      if (radio.station?.id === station.id) radio.stop();
      return `Removed [b]${station.name}[/b]`;
    }

    default:
      return `Unknown command. Type ${config.commandPrefix}help`;
  }
}

async function reply(c: Client, msg: TextMessageEvent, text: string): Promise<void> {
  if (msg.targetMode === TextMessageTarget.Client) await sendPrivateMessage(c, msg.invokerID, text);
  else if (msg.targetMode === TextMessageTarget.Server) await sendServerMessage(c, text);
  else await sendChannelMessage(c, text);
}

function createClient(identity: Identity): Client {
  const c = new Client(identity, config.server, config.nickname, {
    serverPassword: config.serverPassword || undefined,
    defaultChannel: config.channel || undefined,
    defaultChannelPassword: config.channelPassword || undefined,
    reconnect: {},
  });

  let wasConnected = false;

  c.on("connected", ({ reconnected }) => {
    wasConnected = true;
    log("info", reconnected ? "Reconnected to server" : `Connected to ${config.server} as "${config.nickname}"`);
    if (!reconnected && config.autoplay && !radio.isPlaying) {
      const station = findStation(config.defaultStation) ?? stations[0];
      if (station) {
        log("info", `Autoplay: ${station.name}`);
        radio.play(station);
      }
    }
  });

  c.on("disconnected", ({ error, willReconnect }) => {
    log("warn", `Disconnected: ${error?.message ?? "clean"}${willReconnect ? " (reconnecting)" : ""}`);
    // Only a session that was up and that the library gave up on is ours to restart;
    // a failed connect() is retried by connectLoop itself.
    if (wasConnected && !willReconnect && !shuttingDown && c === client) void connectLoop(identity);
  });

  c.on("textMessage", (msg) => {
    if (msg.invokerID === c.clientID) return;
    handleCommand(msg)
      .then((answer) => {
        if (answer) {
          log("info", `${msg.invokerName}: ${msg.message}`);
          return reply(c, msg, answer);
        }
      })
      .catch((err: unknown) => log("error", `Command failed: ${err instanceof Error ? err.message : String(err)}`));
  });

  return c;
}

let connectLoopRunning = false;

async function connectLoop(identity: Identity): Promise<void> {
  if (connectLoopRunning) return;
  connectLoopRunning = true;
  let delay = 10_000;
  try {
    while (!shuttingDown) {
      const c = createClient(identity);
      client = c;
      try {
        log("info", `Connecting to ${config.server}...`);
        await c.connect({ signal: AbortSignal.timeout(30_000) });
        return;
      } catch (err) {
        log("error", `Connect failed: ${err instanceof Error ? err.message : String(err)}`);
        await c.disconnect().catch(() => {});
        // 521: our previous session is still on the server until it times out.
        // 3329: flood ban. Both need a long wait; hammering only extends the ban.
        const code = err instanceof ServerError ? err.code : undefined;
        const wait = code === 521 || code === 3329 ? Math.max(delay, 60_000) : delay;
        log("info", `Retrying in ${wait / 1000}s`);
        await sleep(wait);
        delay = Math.min(delay * 2, 120_000);
      }
    }
  } finally {
    connectLoopRunning = false;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down...");
  radio.stop();
  await client?.disconnect({ reasonMessage: "Radio off" }).catch(() => {});
  process.exit(0);
}

setInterval(() => {
  if (radio.isPlaying) log("info", `Streaming ${radio.station?.name}: ${framesSent} frames sent in the last 60s`);
  framesSent = 0;
}, 60_000).unref();

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log("info", `Loaded ${stations.length} station(s)`);
await connectLoop(await loadIdentity());
