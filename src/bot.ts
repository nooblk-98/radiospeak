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
import { Client, generateIdentity, parseIdentity, subscribeAllChannels, type Identity } from "@honeybbq/teamspeak/client";
import { handleChatMessage } from "./commands.ts";
import type { AppConfig, BotConfig } from "./config.ts";
import { fetchIcyTitle } from "./icy.ts";
import { Player, type PlayerEvent, type Track } from "./player.ts";
import type { PlaylistStore } from "./store.ts";
import { formatDuration, resolve } from "./ytdlp.ts";

/** What every bot shares: config, saved playlists and each other. */
export interface App {
  config: AppConfig;
  playlists: PlaylistStore;
  bots: MusicBot[];
  /** Last !search results per user unique ID, so "!pick 3" can choose one. */
  searchResults: Map<string, Track[]>;
}

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

const TITLE_POLL_MS = 20_000;
const LISTENER_CHECK_MS = 5_000;
const DEFAULT_PLAYLIST_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Nickname/description changes are spaced out so they never add up to a flood ban. */
const PRESENCE_MIN_GAP_MS = 5_000;
/** TeamSpeak's nickname limit. */
const MAX_NICKNAME = 30;

export class MusicBot {
  readonly cfg: BotConfig;
  readonly index: number;
  readonly player: Player;
  client: Client | undefined;
  /** Song title read from the radio stream, when one is playing. */
  radioTitle: string | undefined;

  #app: App;
  #connected = false;
  #shuttingDown = false;
  #connectLoopRunning = false;
  #voiceFailing = false;
  #framesSent = 0;
  #emptySince: number | undefined;
  #presenceTimer: NodeJS.Timeout | undefined;
  #lastPresenceAt = 0;
  #appliedNickname: string;
  #appliedDescription: string | undefined;
  #descriptionDenied = false;
  #titleUrl: string | undefined;
  #defaultLoaded = false;
  /** Set while the channel needs more talk power than the bot has: the server drops its audio. */
  talkBlocked: { needed: number; have: number } | undefined;

  constructor(app: App, cfg: BotConfig, index: number) {
    this.#app = app;
    this.cfg = cfg;
    this.index = index;
    this.#appliedNickname = cfg.nickname;
    this.player = new Player({
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

  // ---- Actions (used by chat commands and the web panel) ----

  /**
   * Queues a song or a playlist from a link or search words. `wholePlaylist`
   * takes the whole playlist when the link is a song inside one.
   */
  async play(input: string, options: { requestedBy?: string; next?: boolean; wholePlaylist?: boolean } = {}): Promise<string> {
    const found = await resolve(this.#app.config.ytdlpPath, input, {
      maxItems: this.#app.config.maxPlaylistItems,
      ...(options.wholePlaylist ? { wholePlaylist: true } : {}),
    });
    return this.enqueue(found.tracks, { ...options, ...(found.playlist ? { playlistName: found.playlist } : {}) }, input);
  }

  enqueue(
    tracks: Track[],
    options: { requestedBy?: string; next?: boolean; playlistName?: string },
    input = "",
  ): string {
    const tagged = tracks.map((t) => ({ ...t, ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}) }));
    const position = this.player.enqueue(tagged, options.next);
    const p = this.#app.config.commandPrefix;
    const hint =
      tracks.length === 1 && /[?&]list=/.test(input) && !options.playlistName
        ? `\n(That link is part of a playlist — ${p}playall <link> queues all of it.)`
        : "";
    if (tracks.length > 1) {
      const what = options.playlistName ? `[b]${options.playlistName}[/b]: ${tracks.length} songs` : `${tracks.length} songs`;
      return `Added ${what}${position === 0 ? ", playing now" : ` from #${position}`}.`;
    }
    const t = tracks[0]!;
    const what = `[b]${t.title}[/b] (${formatDuration(t.duration)})`;
    return (position === 0 ? `Playing: ${what}` : `Queued #${position}: ${what}`) + hint;
  }

  playRadio(url: string | undefined): string {
    if (!url) {
      this.player.playRadio(undefined);
      return "Radio off.";
    }
    let name = url;
    try {
      name = new URL(url).hostname;
    } catch {
      return "That doesn't look like a link.";
    }
    this.player.playRadio({ name, url });
    return this.player.track ? `Radio set; it plays when the queue is empty.` : `Playing radio: ${name}`;
  }

  stop(): string {
    if (!this.player.isActive) return "Not playing.";
    this.player.stop();
    return "Stopped.";
  }

  setVolume(volume: number): string {
    this.player.setVolume(volume);
    return `Volume set to ${this.player.volume}`;
  }

  async moveTo(channelID: ChannelID): Promise<void> {
    const c = this.client;
    if (!c || !this.#connected) throw new Error("Not connected");
    await moveClient(c, c.clientID, channelID);
  }

  status(): string {
    const tb = this.talkBlocked;
    const warning = tb ? `⚠ Nobody can hear me here: this channel needs talk power ${tb.needed}, I have ${tb.have}.\n` : "";
    return warning + this.#nowPlaying();
  }

  #nowPlaying(): string {
    const pl = this.player;
    const paused = pl.userPaused ? " (paused)" : pl.autoPaused ? " (paused: nobody listening)" : "";
    if (pl.track) {
      const t = pl.track;
      const from = t.auto ? " — default playlist" : t.requestedBy ? ` — requested by ${t.requestedBy}` : "";
      const time = `${formatDuration(pl.elapsed)} / ${formatDuration(t.duration)}`;
      const extra = [pl.queue.length ? `${pl.queue.length} queued` : "", pl.loop !== "off" ? `loop ${pl.loop}` : ""]
        .filter(Boolean)
        .join(", ");
      return `▶ [b]${t.title}[/b] [${time}]${from}${paused}${extra ? `\n${extra}` : ""}`;
    }
    if (pl.radio) return `📻 Radio: [b]${pl.radio.name}[/b]${this.radioTitle ? ` — ♪ ${this.radioTitle}` : ""}${paused}`;
    return `Nothing playing. Try ${this.#app.config.commandPrefix}play <song or link>`;
  }

  /** Loads (or reloads) the configured default playlist. */
  async loadDefaultPlaylist(): Promise<void> {
    if (this.#app.playlists.hasDefault(this.name)) {
      const list = this.#app.playlists.defaultFor(this.name);
      this.player.setDefaultPlaylist(list?.tracks ?? [], list?.name);
      return;
    }
    const link = this.cfg.defaultPlaylist;
    if (!link) return;
    try {
      const found = await resolve(this.#app.config.ytdlpPath, link, {
        maxItems: this.#app.config.maxPlaylistItems,
        wholePlaylist: true,
      });
      // A web selection made while the remote lookup was running takes precedence.
      if (this.#app.playlists.hasDefault(this.name)) return this.loadDefaultPlaylist();
      this.player.setDefaultPlaylist(found.tracks, found.playlist);
      this.log("info", `Default playlist: ${found.playlist ?? link} (${found.tracks.length} songs)`);
    } catch (err) {
      this.log("error", `Could not load default playlist: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Connection ----

  async start(): Promise<void> {
    const identity = await this.#loadIdentity();
    setInterval(() => this.#checkListeners(), LISTENER_CHECK_MS).unref();
    setInterval(() => void this.#pollTitle(), TITLE_POLL_MS).unref();
    setInterval(() => void this.loadDefaultPlaylist(), DEFAULT_PLAYLIST_REFRESH_MS).unref();
    setInterval(() => {
      if (this.player.isActive && !this.player.paused) {
        const under = this.player.underruns;
        this.log(
          under > 2 ? "warn" : "info",
          `Streaming: ${this.#framesSent}/3000 frames in the last 60s` +
            (under ? `, ${under} buffer underruns${under > 2 ? " — this machine or its network may be too slow" : ""}` : ""),
        );
      }
      this.#framesSent = 0;
      this.player.underruns = 0;
    }, 60_000).unref();
    await this.#connectLoop(identity);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.player.stop();
    await this.client?.disconnect({ reasonMessage: "Bye" }).catch(() => {});
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
      if (!this.#defaultLoaded) {
        this.#defaultLoaded = true;
        void this.loadDefaultPlaylist();
      }
      this.talkBlocked = undefined;
      // Like the official client: see who is in every channel, so !join can find the caller.
      void subscribeAllChannels(c).catch((err: unknown) =>
        this.log("warn", `Could not subscribe to channels: ${err instanceof Error ? err.message : String(err)}`),
      );
      void c.view.whenReady().then(() => this.#checkTalkPower());
      this.#schedulePresence();
    });

    c.on("disconnected", ({ error, willReconnect }) => {
      this.#connected = false;
      this.log("warn", `Disconnected: ${error?.message ?? "clean"}${willReconnect ? " (reconnecting)" : ""}`);
      // Only a session that was up and that the library gave up on is ours to restart;
      // a failed connect() is retried by #connectLoop itself.
      if (wasConnected && !willReconnect && !this.#shuttingDown && c === this.client) void this.#connectLoop(identity);
    });

    c.on("viewChanged", () => {
      this.#checkListeners();
      this.#checkTalkPower();
    });

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
      // Not connected (yet / while reconnecting): drop the frame, playback keeps going.
      if (!this.#voiceFailing) {
        this.log("warn", `Voice send failed, dropping audio: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#voiceFailing = true;
    }
  }

  /**
   * TeamSpeak silently discards audio from a client whose talk power is below
   * the channel's requirement, so say so loudly and raise the bot's hand.
   */
  #checkTalkPower(): void {
    const c = this.client;
    const cid = this.channelID;
    const self = c?.view.self;
    const channel = cid === undefined ? undefined : c?.view.channel(cid);
    if (!c || !self || !channel) return;
    const needed = channel.neededTalkPower ?? 0;
    const have = self.talkPower ?? 0;
    const blocked = needed > have && !self.isTalker;
    if (blocked === (this.talkBlocked !== undefined)) return;
    this.talkBlocked = blocked ? { needed, have } : undefined;
    if (blocked) {
      const msg =
        `Can't be heard in #${channel.name}: it needs talk power ${needed}, the bot has ${have}. ` +
        `Grant the bot talk power, give its server group more, or move it to another channel.`;
      this.log("warn", msg);
      void sendChannelMessage(c, `⚠ ${msg}`).catch(() => {});
      void updateClient(c, { isRequestingTalk: true, talkRequestMessage: "Music bot: please grant talk power" }).catch(() => {});
    } else {
      this.log("info", `Talk power OK in #${channel.name}`);
      if (self.isRequestingTalk) void updateClient(c, { isRequestingTalk: false }).catch(() => {});
    }
  }

  // ---- Auto-pause, radio titles, nickname/description ----

  #checkListeners(): void {
    const c = this.client;
    if (!this.#app.config.pauseWhenEmpty || !c || !this.#connected || c.view.status !== "live") return;
    if (this.listeners().length > 0) {
      this.#emptySince = undefined;
      if (this.player.autoPaused) {
        this.log("info", "Listener joined, resuming");
        this.player.setAutoPaused(false);
      }
      return;
    }
    this.#emptySince ??= Date.now();
    const graceOver = Date.now() - this.#emptySince >= this.#app.config.emptyGraceSeconds * 1000;
    if (graceOver && this.player.isActive && !this.player.autoPaused) {
      this.log("info", "Nobody listening, pausing");
      this.player.setAutoPaused(true);
    }
  }

  async #pollTitle(): Promise<void> {
    const url = this.player.radioUrl;
    if (!url || this.player.paused || !this.#connected) return;
    const title = await fetchIcyTitle(url);
    if (url !== this.player.radioUrl || (url === this.#titleUrl && title === this.radioTitle)) return;
    this.#titleUrl = url;
    this.radioTitle = title;
    this.#schedulePresence();
  }

  #onPlayerEvent(event: PlayerEvent): void {
    const c = this.client;
    const online = c && this.#connected;
    if (event.type === "trackStart" && online && !event.track.auto) {
      const by = event.track.requestedBy ? ` (requested by ${event.track.requestedBy})` : "";
      void sendChannelMessage(c, `▶ Now playing: [b]${event.track.title}[/b]${by}`).catch(() => {});
    }
    if (event.type === "trackEnd" && event.error) {
      this.log("warn", `Could not play ${event.track.title}: ${event.error}`);
      if (online && !event.track.auto) {
        void sendChannelMessage(c, `Could not play ${event.track.title}: ${event.error.slice(0, 200)}`).catch(() => {});
      }
    }
    if (event.type === "change" && this.player.radioUrl !== this.#titleUrl) {
      this.radioTitle = undefined;
      this.#titleUrl = undefined;
      void this.#pollTitle();
    }
    this.#schedulePresence();
  }

  /** Coalesces bursts of changes into one nickname/description update, at most every few seconds. */
  #schedulePresence(): void {
    clearTimeout(this.#presenceTimer);
    const wait = Math.max(1500, this.#lastPresenceAt + PRESENCE_MIN_GAP_MS - Date.now());
    this.#presenceTimer = setTimeout(() => void this.#applyPresence(), wait);
  }

  async #applyPresence(): Promise<void> {
    const c = this.client;
    if (!c || !this.#connected) return;
    const { config } = this.#app;
    const pl = this.player;
    const now = pl.track?.title ?? (pl.radio ? (this.radioTitle ?? pl.radio.name) : undefined);

    let nickname = this.cfg.nickname;
    if (config.showSongInNickname && now) nickname = `${this.cfg.nickname} | ${now}`;
    nickname = nickname.slice(0, MAX_NICKNAME).trim();
    if (nickname !== this.#appliedNickname) {
      this.#lastPresenceAt = Date.now();
      try {
        await updateClient(c, { nickname });
      } catch (err) {
        this.log("warn", `Could not set nickname "${nickname}": ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#appliedNickname = nickname; // don't retry the same name every change
    }

    if (!config.songInDescription || this.#descriptionDenied) return;
    const description = (now ? `${pl.track ? "▶" : "📻"} ${now}` : `Type ${config.commandPrefix}help`).slice(0, 200);
    if (description === this.#appliedDescription) return;
    this.#lastPresenceAt = Date.now();
    try {
      await editClient(c, c.clientID, { description });
      this.#appliedDescription = description;
    } catch (err) {
      this.#descriptionDenied = true;
      this.log("warn", `Can't set own description (needs b_client_modify_own_description): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
