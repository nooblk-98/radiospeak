import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Codec,
  ServerError,
  editClient,
  moveClient,
  sendChannelMessage,
  updateClient,
  type ChannelID,
  type ClientEntry,
  type ClientID,
} from "@honeybbq/teamspeak";
import { Client, generateIdentity, parseIdentity, type Identity } from "@honeybbq/teamspeak/client";
import { handleChatMessage } from "./commands.ts";
import type { AppConfig, BotConfig, Station } from "./config.ts";
import { fetchIcyTitle } from "./icy.ts";
import { RadioPlayer, type PlayerEvent, type Track } from "./radio.ts";
import type { FoundStation } from "./radiobrowser.ts";
import type { ScheduleStore, StationStore } from "./store.ts";
import { resolveTrack } from "./ytdlp.ts";

/** What every bot shares: config, the station list, the schedule and each other. */
export interface App {
  config: AppConfig;
  stations: StationStore;
  schedule: ScheduleStore;
  bots: RadioBot[];
  /** Last !search results per user unique ID, so "!add 3" can pick one. */
  searchResults: Map<string, FoundStation[]>;
}

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

const TITLE_POLL_MS = 20_000;
const LISTENER_CHECK_MS = 5_000;
/** TeamSpeak's nickname limit. */
const MAX_NICKNAME = 30;

export class RadioBot {
  readonly cfg: BotConfig;
  readonly index: number;
  readonly radio: RadioPlayer;
  client: Client | undefined;
  /** Latest ICY song title of the playing station. */
  songTitle: string | undefined;
  /** The stream `songTitle` was read from. */
  #titleUrl: string | undefined;

  #app: App;
  #connected = false;
  #shuttingDown = false;
  #connectLoopRunning = false;
  #voiceFailing = false;
  #framesSent = 0;
  #emptySince: number | undefined;
  #presenceTimer: NodeJS.Timeout | undefined;
  #appliedNickname: string;
  #appliedDescription: string | undefined;
  #descriptionDenied = false;

  constructor(app: App, cfg: BotConfig, index: number) {
    this.#app = app;
    this.cfg = cfg;
    this.index = index;
    this.#appliedNickname = cfg.nickname;
    this.radio = new RadioPlayer({
      ffmpegPath: app.config.ffmpegPath,
      ytdlpPath: app.config.ytdlpPath,
      bitrateKbps: app.config.bitrateKbps,
      volume: cfg.volume,
      log: (level, msg) => this.log(level, msg),
      sendFrame: (frame) => this.#sendFrame(frame),
      onEvent: (event) => this.#onPlayerEvent(event),
    });
  }

  get name(): string {
    return this.cfg.name;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get clientID(): ClientID | undefined {
    return this.#connected ? this.client?.clientID : undefined;
  }

  get channelID(): ChannelID | undefined {
    return this.#connected ? this.client?.channelID : undefined;
  }

  get channelName(): string | undefined {
    const cid = this.channelID;
    return cid === undefined ? undefined : this.client?.view.channel(cid)?.name;
  }

  log(level: LogLevel, msg: string): void {
    log(level, this.#app.bots.length > 1 ? `[${this.name}] ${msg}` : msg);
  }

  /** People in the bot's channel who can hear it: voice clients, not deafened, not one of our bots. */
  listeners(): ClientEntry[] {
    const c = this.client;
    const cid = this.channelID;
    if (!c || cid === undefined) return [];
    const own = new Set(this.#app.bots.map((b) => b.clientID));
    return c.view.clientsIn(cid).filter((e) => e.type === 0 && !own.has(e.id) && !e.isOutputMuted);
  }

  // ---- Playback actions (used by chat commands, the web panel and the scheduler) ----

  playStation(station: Station): string {
    this.radio.play(station);
    const paused = this.radio.paused ? " (paused until someone joins the channel)" : "";
    return `Now playing: [b]${station.name}[/b]${paused}`;
  }

  /** `step` 1 for next, -1 for previous. */
  switchStation(step: number): string {
    const list = this.#app.stations.items;
    if (list.length === 0) return "No stations configured.";
    const i = this.#app.stations.indexOf(this.radio.station?.id);
    return this.playStation(list[i < 0 ? 0 : (i + step + list.length) % list.length]!);
  }

  stop(): string {
    if (!this.radio.isActive) return "Not playing.";
    this.radio.stop();
    return "Stopped.";
  }

  setVolume(volume: number): string {
    this.radio.setVolume(volume);
    return `Volume set to ${this.radio.volume}`;
  }

  async enqueue(input: string, requestedBy?: string): Promise<string> {
    const found = await resolveTrack(this.#app.config.ytdlpPath, input);
    const track: Track = { url: found.url, title: found.title, ...(requestedBy ? { requestedBy } : {}) };
    const position = this.radio.enqueue(track);
    return this.radio.track === track ? `Playing: [b]${track.title}[/b]` : `Queued #${position}: [b]${track.title}[/b]`;
  }

  async moveTo(channelID: ChannelID): Promise<void> {
    const c = this.client;
    if (!c || !this.#connected) throw new Error("Not connected");
    await moveClient(c, c.clientID, channelID);
  }

  status(): string {
    const r = this.radio;
    if (r.track) return `Playing track: [b]${r.track.title}[/b] — volume ${r.volume}${r.queue.length ? `, ${r.queue.length} queued` : ""}`;
    if (!r.station) return "Not playing. Use !play";
    const song = this.songTitle ? ` — ♪ ${this.songTitle}` : "";
    const paused = r.paused ? " (paused: nobody listening)" : "";
    return `Playing: [b]${r.station.name}[/b]${song} — volume ${r.volume}${paused}`;
  }

  // ---- Connection ----

  async start(): Promise<void> {
    const identity = await this.#loadIdentity();
    setInterval(() => this.#checkListeners(), LISTENER_CHECK_MS).unref();
    setInterval(() => void this.#pollTitle(), TITLE_POLL_MS).unref();
    setInterval(() => {
      if (this.radio.isActive && !this.radio.paused) {
        this.log("info", `Streaming: ${this.#framesSent} frames sent in the last 60s`);
      }
      this.#framesSent = 0;
    }, 60_000).unref();
    await this.#connectLoop(identity);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.radio.stop();
    await this.client?.disconnect({ reasonMessage: "Radio off" }).catch(() => {});
  }

  async #loadIdentity(): Promise<Identity> {
    const file = this.cfg.identityFile;
    if (existsSync(file)) return parseIdentity(readFileSync(file, "utf8").trim());
    this.log("info", `Generating new identity (level ${this.#app.config.identityLevel})...`);
    const identity = await generateIdentity(this.#app.config.identityLevel);
    writeFileSync(file, identity.export() + "\n");
    this.log("info", `Saved identity to ${file}`);
    return identity;
  }

  #createClient(identity: Identity): Client {
    const { config } = this.#app;
    const c = new Client(identity, config.server, this.cfg.nickname, {
      serverPassword: config.serverPassword || undefined,
      defaultChannel: this.cfg.channel || undefined,
      defaultChannelPassword: this.cfg.channelPassword || undefined,
      reconnect: {},
    });
    let wasConnected = false;

    c.on("connected", ({ reconnected }) => {
      wasConnected = true;
      this.#connected = true;
      this.#appliedNickname = this.cfg.nickname;
      this.#appliedDescription = undefined;
      this.log("info", reconnected ? "Reconnected to server" : `Connected to ${config.server} as "${this.cfg.nickname}"`);
      if (!reconnected && this.cfg.autoplay && !this.radio.isActive) {
        const station = this.#app.stations.find(this.cfg.defaultStation) ?? this.#app.stations.items[0];
        if (station) {
          this.log("info", `Autoplay: ${station.name}`);
          this.radio.play(station);
        }
      }
      this.#schedulePresence();
    });

    c.on("disconnected", ({ error, willReconnect }) => {
      this.#connected = false;
      this.log("warn", `Disconnected: ${error?.message ?? "clean"}${willReconnect ? " (reconnecting)" : ""}`);
      // Only a session that was up and that the library gave up on is ours to restart;
      // a failed connect() is retried by #connectLoop itself.
      if (wasConnected && !willReconnect && !this.#shuttingDown && c === this.client) void this.#connectLoop(identity);
    });

    c.on("viewChanged", () => this.#checkListeners());

    c.on("textMessage", (msg) => {
      if (this.#app.bots.some((b) => b.clientID === msg.invokerID)) return;
      // With several bots, a channel or server message is answered by one of them only.
      if (msg.targetMode === 3 && this.index !== 0) return;
      if (msg.targetMode === 2) {
        const first = this.#app.bots.find((b) => b.channelID !== undefined && b.channelID === this.channelID);
        if (first !== this) return;
      }
      void handleChatMessage(this.#app, this, c, msg);
    });

    return c;
  }

  async #connectLoop(identity: Identity): Promise<void> {
    if (this.#connectLoopRunning) return;
    this.#connectLoopRunning = true;
    let delay = 10_000;
    try {
      while (!this.#shuttingDown) {
        const c = this.#createClient(identity);
        this.client = c;
        try {
          this.log("info", `Connecting to ${this.#app.config.server}...`);
          await c.connect({ signal: AbortSignal.timeout(30_000) });
          return;
        } catch (err) {
          this.log("error", `Connect failed: ${err instanceof Error ? err.message : String(err)}`);
          await c.disconnect().catch(() => {});
          // 521: our previous session is still on the server until it times out.
          // 3329: flood ban. Both need a long wait; hammering only extends the ban.
          const code = err instanceof ServerError ? err.code : undefined;
          const wait = code === 521 || code === 3329 ? Math.max(delay, 60_000) : delay;
          this.log("info", `Retrying in ${wait / 1000}s`);
          await sleep(wait);
          delay = Math.min(delay * 2, 120_000);
        }
      }
    } finally {
      this.#connectLoopRunning = false;
    }
  }

  #sendFrame(frame: Uint8Array): void {
    try {
      this.client?.sendVoice(frame, Codec.OpusMusic);
      if (frame.length > 0) this.#framesSent++;
      if (this.#voiceFailing) this.log("info", "Voice sending resumed");
      this.#voiceFailing = false;
    } catch (err) {
      // Not connected (yet / while reconnecting): drop the frame, the radio keeps running.
      if (!this.#voiceFailing) {
        this.log("warn", `Voice send failed, dropping audio: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#voiceFailing = true;
    }
  }

  // ---- Auto-pause, song titles, nickname/description ----

  #checkListeners(): void {
    const c = this.client;
    if (!this.#app.config.pauseWhenEmpty || !c || !this.#connected || c.view.status !== "live") return;
    if (this.listeners().length > 0) {
      this.#emptySince = undefined;
      if (this.radio.paused) {
        this.log("info", "Listener joined, resuming");
        this.radio.resume();
      }
      return;
    }
    this.#emptySince ??= Date.now();
    const graceOver = Date.now() - this.#emptySince >= this.#app.config.emptyGraceSeconds * 1000;
    if (graceOver && this.radio.isActive && !this.radio.paused) {
      this.log("info", "Nobody listening, pausing stream");
      this.radio.pause();
    }
  }

  async #pollTitle(): Promise<void> {
    const url = this.radio.streamUrl;
    if (!url || this.radio.paused || !this.#connected) return;
    const title = await fetchIcyTitle(url);
    if (url !== this.radio.streamUrl || (url === this.#titleUrl && title === this.songTitle)) return;
    this.#titleUrl = url;
    this.songTitle = title;
    if (title) this.log("info", `Song: ${title}`);
    if (title && this.#app.config.announceSongs && this.client && this.#connected) {
      await sendChannelMessage(this.client, `♪ ${title}`).catch(() => {});
    }
    this.#schedulePresence();
  }

  #onPlayerEvent(event: PlayerEvent): void {
    const c = this.client;
    if (event.type === "trackStart" && c && this.#connected) {
      void sendChannelMessage(c, `▶ Now playing: [b]${event.track.title}[/b]`).catch(() => {});
    }
    if (event.type === "trackEnd" && event.error && c && this.#connected) {
      void sendChannelMessage(c, `Could not play ${event.track.title}: ${event.error.slice(0, 200)}`).catch(() => {});
    }
    if (event.type === "change" && this.radio.streamUrl !== this.#titleUrl) {
      this.songTitle = undefined;
      this.#titleUrl = undefined;
      void this.#pollTitle();
    }
    this.#schedulePresence();
  }

  /** Coalesces bursts of changes into one nickname/description update. */
  #schedulePresence(): void {
    clearTimeout(this.#presenceTimer);
    this.#presenceTimer = setTimeout(() => void this.#applyPresence(), 1500);
  }

  async #applyPresence(): Promise<void> {
    const c = this.client;
    if (!c || !this.#connected) return;
    const { config } = this.#app;
    const r = this.radio;

    let nickname = this.cfg.nickname;
    if (config.showStationInNickname) {
      const what = r.track ? `▶ ${r.track.title}` : r.station?.name;
      if (what) nickname = `${this.cfg.nickname} | ${what}`;
    }
    nickname = nickname.slice(0, MAX_NICKNAME).trim();
    if (nickname !== this.#appliedNickname) {
      try {
        await updateClient(c, { nickname });
        this.#appliedNickname = nickname;
      } catch (err) {
        this.log("warn", `Could not set nickname "${nickname}": ${err instanceof Error ? err.message : String(err)}`);
        this.#appliedNickname = nickname; // don't retry the same name every change
      }
    }

    if (!config.songInDescription || this.#descriptionDenied) return;
    let description: string;
    if (r.track) description = `▶ ${r.track.title}`;
    else if (r.station) {
      description = `📻 ${r.station.name}${this.songTitle ? ` — ♪ ${this.songTitle}` : ""}${r.paused ? " (paused)" : ""}`;
    } else description = `Stopped — type ${config.commandPrefix}help`;
    description = description.slice(0, 200);
    if (description === this.#appliedDescription) return;
    try {
      await editClient(c, c.clientID, { description });
      this.#appliedDescription = description;
    } catch (err) {
      this.#descriptionDenied = true;
      this.log("warn", `Can't set own description (needs b_client_modify_own_description): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
