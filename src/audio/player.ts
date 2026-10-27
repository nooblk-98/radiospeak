/** Playback state machine and paced Opus delivery shared by TeamSpeak and Discord. */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  prebufferBudget,
  settingsFrom,
  type BotSettings,
  type PrebufferBudget,
} from "../domain/policies.ts";
import { trackKey } from "../domain/track-key.ts";
import type { AudioSource } from "../media/audio-sources.ts";
import { AudioGain } from "./audio-gain.ts";
import { OggPacketReader, isOpusHeader } from "./ogg.ts";
import { artistKey, spreadShuffle } from "./shuffle.ts";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
/** Opus frames buffered before playback starts or resumes after an underrun. */
const PREBUFFER_FRAMES = 5;
/** Keep live gain changes within 200 ms, including raw samples held by FFmpeg. */
const ENCODER_CREDIT_FRAMES = 10;
/**
 * Above this many queued frames the encoder's output is paused, which backs up
 * through the whole pipeline (encoder, volume, decoder, yt-dlp). Kept small so a
 * encoded output stays small. AudioGain separately bounds PCM submitted to the
 * encoder so quiet/compressible audio cannot hide volume changes in pipe buffers.
 */
const QUEUE_HIGH = 50;
const QUEUE_LOW = 25;
/** If the event loop stalls longer than this, drop the backlog of due frames instead of bursting. */
const MAX_LATE_MS = 200;
/** A radio stream that dies sooner than this backs off before reconnecting. */
const HEALTHY_MS = 30_000;
const MAX_FAIL_STREAK = 5;

/** A song (YouTube, SoundCloud or anything yt-dlp plays). */
export interface Track {
  url: string;
  title: string;
  /** Seconds, when known. */
  duration?: number;
  artist?: string;
  thumbnail?: string;
  requestedBy?: string;
  requesterId?: string;
  /** Idempotent import entry identifier; never accepted from the public track API. */
  importKey?: string;
  /** From the default playlist, played only while nobody has requested anything. */
  auto?: boolean;
  /** The saved playlist this request was queued from; songs added to it later follow it into the queue. */
  playlistId?: string;
}

/** A live stream played whenever the queue is empty. */
export interface RadioStream {
  name: string;
  url: string;
}

export type LoopMode = "off" | "one" | "all";

export interface PlaybackSnapshot {
  track: Track | null;
  queue: Track[];
  elapsed: number;
  radio: RadioStream | null;
  defaultName: string | null;
  defaultIndex: number;
  volume: number;
  loop: LoopMode;
  shuffle: boolean;
  normalization: boolean;
  userPaused: boolean;
  stopped: boolean;
  prebuffer?: boolean;
}

export type PlayerEvent =
  | { type: "trackStart"; track: Track }
  | { type: "trackEnd"; track: Track; error?: string }
  | { type: "change" };

export interface PlayerOptions {
  ffmpegPath: string;
  ytdlpPath: string;
  bitrateKbps: number;
  volume: number;
  connectionPaused?: boolean;
  /** Called with one 20 ms Opus frame; an empty frame means "stopped talking". */
  sendFrame: (frame: Uint8Array) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  onEvent?: (event: PlayerEvent) => void;
  prebufferBudget?: PrebufferBudget;
  /** Resolve a seekable input once and reuse it for seeking and short reconnects. */
  resolveSource?: (url: string, signal: AbortSignal) => Promise<AudioSource | null>;
  invalidateSource?: (url: string) => void;
}

interface Pipeline {
  kind: "track" | "radio";
  procs: ChildProcess[];
  encoderOut?: Readable;
  sourceController?: AbortController;
  sourceMode?: "direct" | "pipe";
  sourceLookupMs?: number;
  firstFrameMs?: number;
  startedAt: number;
  activatedAt?: number;
  initialTrackFrames: number;
  /** The encoder finished: everything left is in the frame queue. */
  ended: boolean;
  /** The decoder or yt-dlp failed; the reason, for reporting. */
  failure: string | undefined;
  frames: Buffer[];
  reader: OggPacketReader;
  readPaused: boolean;
  gain?: AudioGain;
  submittedFrames: number;
  playedFrames: number;
  levels: { rms: number; peak: number; gain: number }[];
}

/**
 * The bot's audio: a queue of songs, an optional radio stream for when the
 * queue is empty, pause/resume, loop and shuffle. ffmpeg decodes, volume is
 * applied in between, and a second ffmpeg encodes Opus natively.
 */
export class Player {
  #opts: PlayerOptions;
  #queue: Track[] = [];
  #track: Track | undefined;
  #radio: RadioStream | undefined;
  #defaultList: Track[] = [];
  #defaultName: string | undefined;
  #defaultIndex = 0;
  #idleOrder: number[] = [];
  #loop: LoopMode = "off";
  #volume: number;
  #normalization = false;
  #shuffleEnabled = false;
  #history: Track[] = [];
  #userPaused = false;
  #autoPaused = false;
  #connectionPaused: boolean;
  #stopped = false;

  #pipe: Pipeline | undefined;
  #prepared: { track: Track; pipe: Pipeline; release: () => void } | undefined;
  #cancelBudgetWait?: () => void;
  #settings = settingsFrom();
  #recent: string[] = [];
  #idleTimer?: NodeJS.Timeout;
  #parked = false;
  #radioFallbacks: RadioStream[] = [];
  #radioFailures = 0;
  #failoverReason: string | null = null;
  #prebuffer = false;
  #prepareFailedUrl: string | undefined;
  #legacyTrackUrl: string | undefined;
  #warmSource: { url: string; controller: AbortController } | undefined;
  #retries = 0;
  #retrying = false;
  #lastError: string | null = null;
  #totalUnderruns = 0;
  #buffering = true;
  #bufferingSince = Date.now();
  #clockStart = 0;
  #framesSent = 0;
  #trackFrames = 0;
  #timer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #radioDelayMs = 2000;
  #talking = false;
  #level = { rmsDb: -96, peakDb: -96, sourceDb: -96 };
  #quietFrames = 0;
  #silenceAlert: { id: string; message: string; at: string } | null = null;
  #silenceReported = false;
  #deadlineSamples = 0;
  #deadlineTotal = 0;
  #deadlineMax = 0;
  /** Songs that failed in a row; playback stops at MAX_FAIL_STREAK rather than racing through a broken list. */
  #failStreak = 0;
  /** Times playback ran dry mid-stream; a steady climb means the machine or network can't keep up. */
  underruns = 0;

  constructor(opts: PlayerOptions) {
    this.#opts = opts;
    this.#volume = opts.volume;
    this.#connectionPaused = opts.connectionPaused ?? false;
  }

  get track(): Track | undefined {
    return this.#track;
  }
  get queue(): readonly Track[] {
    return this.#queue;
  }
  get radio(): RadioStream | undefined {
    return this.#radio;
  }
  get loop(): LoopMode {
    return this.#loop;
  }
  get volume(): number {
    return this.#volume;
  }
  get normalization(): boolean {
    return this.#normalization;
  }
  get shuffleEnabled(): boolean {
    return this.#shuffleEnabled;
  }
  get canGoBack(): boolean {
    return this.#history.length > 0 || !!this.#track;
  }
  /** Paused by a user command. */
  get userPaused(): boolean {
    return this.#userPaused;
  }
  /** Paused because nobody is listening. */
  get autoPaused(): boolean {
    return this.#autoPaused;
  }
  get paused(): boolean {
    return this.#userPaused || this.#autoPaused || this.#connectionPaused;
  }
  get connectionPaused(): boolean {
    return this.#connectionPaused;
  }

  snapshot(): PlaybackSnapshot {
    return {
      track: this.#track ? { ...this.#track } : null,
      queue: this.#queue.map((t) => ({ ...t })),
      elapsed: this.elapsed,
      radio: this.#radio ? { ...this.#radio } : null,
      defaultName: this.#defaultName ?? null,
      defaultIndex: this.#defaultIndex,
      volume: this.#volume,
      loop: this.#loop,
      shuffle: this.#shuffleEnabled,
      normalization: this.#normalization,
      userPaused: this.#userPaused,
      stopped: this.#stopped,
      prebuffer: this.#prebuffer,
    };
  }

  /** Restore before connecting; audio starts only once the transport resumes. */
  restore(saved: PlaybackSnapshot): void {
    const validTrack = (t: Track) =>
      t && typeof t.url === "string" && /^https?:\/\//i.test(t.url) && typeof t.title === "string";
    if (
      !saved ||
      !Array.isArray(saved.queue) ||
      !saved.queue.every(validTrack) ||
      (saved.track !== null && !validTrack(saved.track)) ||
      !Number.isFinite(saved.elapsed) ||
      saved.elapsed < 0 ||
      !Number.isInteger(saved.defaultIndex) ||
      saved.defaultIndex < 0 ||
      !Number.isFinite(saved.volume) ||
      !["off", "all", "one"].includes(saved.loop) ||
      (saved.radio !== null &&
        (!saved.radio ||
          typeof saved.radio.url !== "string" ||
          !/^https?:\/\//i.test(saved.radio.url)))
    ) {
      throw new Error("Invalid playback checkpoint");
    }
    this.#teardown();
    this.#track = saved.stopped ? undefined : (saved.track ?? undefined);
    this.#queue = saved.stopped ? [] : saved.queue.map((t) => ({ ...t }));
    const elapsed = this.#track?.duration
      ? Math.min(saved.elapsed, Math.max(0, this.#track.duration - 1))
      : saved.elapsed;
    this.#trackFrames = this.#track ? Math.floor((elapsed * 1000) / FRAME_MS) : 0;
    this.#radio = saved.stopped ? undefined : (saved.radio ?? undefined);
    this.#defaultName = saved.defaultName ?? undefined;
    this.#defaultIndex = saved.defaultIndex;
    this.#volume = Math.max(0, Math.min(100, saved.volume));
    this.#loop = saved.loop;
    this.#shuffleEnabled = !!saved.shuffle;
    this.#normalization = !!saved.normalization;
    this.#userPaused = !!saved.userPaused;
    this.#stopped = !!saved.stopped;
    this.#prebuffer = !!saved.prebuffer;
    if (!this.paused && this.isActive) this.#restart();
    this.#emit({ type: "change" });
  }

  /** Freeze the current decoder/position while TeamSpeak is unavailable. */
  setConnectionPaused(paused: boolean): void {
    if (paused === this.#connectionPaused) return;
    this.#connectionPaused = paused;
    this.#applyPause();
  }
  /** Something is playing or would be if not paused. */
  get isActive(): boolean {
    return this.#track !== undefined || this.#radio !== undefined;
  }
  get health() {
    return {
      phase: !this.isActive
        ? "idle"
        : this.paused
          ? "paused"
          : this.#retrying
            ? "retrying"
            : this.#pipe?.sourceController && !this.#pipe.sourceMode
              ? "resolving"
              : this.#buffering
                ? "buffering"
                : "playing",
      processingMs:
        this.#pipe && this.#buffering && !this.paused
          ? Date.now() - (this.#pipe.activatedAt ?? this.#pipe.startedAt)
          : 0,
      bufferedSeconds: ((this.#pipe?.frames.length ?? 0) * FRAME_MS) / 1000,
      buffering: this.#buffering,
      encoderInFlight: this.#pipe ? this.#pipe.submittedFrames - this.#pipe.playedFrames : 0,
      sourceMode: this.#pipe?.sourceMode ?? null,
      sourceLookupMs: this.#pipe?.sourceLookupMs ?? null,
      startupMs: this.#pipe?.firstFrameMs ?? null,
      underruns: this.#totalUnderruns,
      retrying: this.#retrying,
      retryAttempt: this.#retries,
      lastError: this.#lastError,
      prebufferEnabled: this.#prebuffer,
      prebufferStatus: !this.#prebuffer
        ? "off"
        : this.#prepared
          ? this.#prepared.pipe.frames.length >= PREBUFFER_FRAMES
            ? "ready"
            : "preparing"
          : "standby",
      activeProcesses: (this.#pipe?.procs.length ?? 0) + (this.#prepared?.pipe.procs.length ?? 0),
      audioProfile: this.#settings.audioProfile,
      parked: this.#parked,
      prebufferSlots: (this.#opts.prebufferBudget ?? prebufferBudget).used,
      failoverReason: this.#failoverReason,
      level: this.paused || !this.#pipe ? { rmsDb: -96, peakDb: -96, sourceDb: -96 } : this.#level,
      silenceAlert: this.#silenceAlert,
      silenceSeconds: (this.#quietFrames * FRAME_MS) / 1000,
      frameTiming: {
        samples: this.#deadlineSamples,
        meanLateMs: this.#deadlineSamples
          ? Math.round((this.#deadlineTotal / this.#deadlineSamples) * 100) / 100
          : 0,
        maxLateMs: Math.round(this.#deadlineMax * 100) / 100,
      },
    };
  }
  configure(value: BotSettings): void {
    const before = this.#settings.audioProfile;
    const releaseChanged = value.idleReleaseSeconds !== this.#settings.idleReleaseSeconds;
    this.#settings = settingsFrom(value);
    if (before !== this.#settings.audioProfile && this.isActive) this.#restart();
    if (releaseChanged && this.paused) this.#applyPause();
  }
  setRecentTracks(urls: string[]): void {
    this.#recent = urls.slice(0, 100).map(trackKey);
  }
  setRadioFallbacks(stations: RadioStream[]): void {
    this.#radioFallbacks = stations.map((s) => ({ ...s }));
  }
  checkQueue(tracks: readonly Track[], replace = false): void {
    if ((replace ? 0 : this.#queue.length) + tracks.length > this.#settings.queue.maxTracks)
      throw new Error(
        `Queue limit is ${this.#settings.queue.maxTracks} tracks. Remove some tracks first.`,
      );
  }
  setPrebuffer(enabled: boolean): void {
    this.#prebuffer = enabled;
    if (!enabled) this.#cancelPrepared();
    else this.#prepareNext();
    this.#emit({ type: "change" });
  }
  /** Places songs right after the queued songs from saved playlist `playlistId`, or first in line when none are left. */
  insertFromPlaylist(tracks: Track[], playlistId: string): void {
    if (!tracks.length) return;
    this.checkQueue(tracks);
    const last = this.#queue.findLastIndex((t) => t.playlistId === playlistId);
    this.#queue.splice(last + 1, 0, ...tracks);
    this.#emit({ type: "change" });
  }
  insertAt(track: Track, position: number): boolean {
    this.checkQueue([track]);
    if (!Number.isInteger(position) || position < 1 || position > this.#queue.length + 1)
      return false;
    this.#queue.splice(position - 1, 0, track);
    this.#emit({ type: "change" });
    return true;
  }
  /** Seconds into the current song. */
  get elapsed(): number {
    return (this.#trackFrames * FRAME_MS) / 1000;
  }
  /** The radio URL being played (for song titles); undefined while a song plays. */
  get radioUrl(): string | undefined {
    return this.#track ? undefined : this.#radio?.url;
  }
  get defaultPlaylist(): { name: string | undefined; size: number } {
    return { name: this.#defaultName, size: this.#defaultList.length };
  }

  /**
   * Songs to play, in order and on repeat, whenever the queue is empty and no
   * radio stream is set. Starts right away if the bot is idle.
   */
  setDefaultPlaylist(tracks: Track[], name: string | undefined): void {
    // Reloading the same list (a periodic refresh) keeps the place in it.
    const samePlace =
      tracks.length > 0 &&
      ((name !== undefined && name === this.#defaultName) ||
        (tracks.length === this.#defaultList.length &&
          tracks.every((t, i) => t.url === this.#defaultList[i]?.url)));
    this.#defaultList = tracks.map((t) => ({ ...t, auto: true }));
    this.#idleOrder = [];
    this.#defaultName = name;
    this.#defaultIndex = samePlace ? this.#defaultIndex % tracks.length : 0;
    if (!this.#track && !this.#radio && !this.#stopped) this.#advance();
    else this.#emit({ type: "change" });
  }

  /** Starts the queue / radio / default playlist if nothing is playing. */
  playIfIdle(): boolean {
    if (this.#track) return false;
    this.#stopped = false;
    this.#userPaused = false;
    this.#failStreak = 0;
    this.#advance();
    return this.#track !== undefined || this.#radio !== undefined;
  }

  /** Adds songs to the end (or the front with `next`); starts playing if idle. Returns the first one's queue position, 0 if it started now. */
  enqueue(tracks: Track[], next = false): number {
    if (tracks.length === 0) return -1;
    this.checkQueue(tracks);
    this.#stopped = false;
    if (next) this.#queue.unshift(...tracks);
    else this.#queue.push(...tracks);
    if (this.#shuffleEnabled && !next) this.shuffle();
    this.#failStreak = 0;
    const position = next ? 1 : this.#queue.length - tracks.length + 1;
    // A request replaces a default-playlist song at once; that list picks up again when the queue is empty.
    if (this.#track?.auto) {
      this.#finishTrack(undefined, true, true);
      return 0;
    }
    if (!this.#track) {
      this.#advance();
      return 0;
    }
    this.#emit({ type: "change" });
    return position;
  }

  /** Skip the current song and `count - 1` more after it. */
  skip(count = 1): boolean {
    if (!this.#track) return false;
    this.#queue.splice(0, Math.max(0, count - 1));
    this.#finishTrack(undefined, true, true);
    return true;
  }

  playRadio(stream: RadioStream | undefined): void {
    this.#radio = stream;
    if (stream) this.#stopped = false;
    this.#radioDelayMs = 2000;
    this.#radioFailures = 0;
    this.#failoverReason = null;
    // A station takes over from the idle playlist at once; user requests still finish first.
    if (stream && this.#track?.auto) this.#finishTrack(undefined, true, true);
    else if (!this.#track) {
      if (!stream && !this.#stopped) this.#advance();
      else this.#restart();
    }
    this.#emit({ type: "change" });
  }

  stop(): void {
    clearTimeout(this.#idleTimer);
    this.#parked = false;
    this.#cancelPrepared();
    this.#retrying = false;
    this.#stopped = true;
    this.#queue = [];
    this.#track = undefined;
    this.#trackFrames = 0;
    this.#radio = undefined;
    this.#userPaused = false;
    this.#teardown();
    this.#emit({ type: "change" });
  }

  clearQueue(): void {
    this.#queue = [];
    this.#emit({ type: "change" });
  }

  removeAt(position: number): Track | undefined {
    if (!Number.isInteger(position) || position < 1 || position > this.#queue.length)
      return undefined;
    const [removed] = this.#queue.splice(position - 1, 1);
    if (removed) this.#emit({ type: "change" });
    return removed;
  }

  /** Random order that keeps songs by the same artist apart, starting away from the current song's artist. */
  shuffle(): void {
    this.#queue = spreadShuffle(
      this.#queue,
      artistKey,
      this.#track ? artistKey(this.#track) : undefined,
    );
    this.#emit({ type: "change" });
  }

  setShuffle(enabled: boolean): void {
    this.#shuffleEnabled = enabled;
    this.#idleOrder = [];
    if (enabled) this.shuffle();
    else this.#emit({ type: "change" });
  }

  moveAt(from: number, to: number): boolean {
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= this.#queue.length))
      return false;
    this.#queue.splice(to - 1, 0, this.#queue.splice(from - 1, 1)[0]!);
    this.#emit({ type: "change" });
    return true;
  }

  /** Plays `tracks` at once; `replaceQueue` drops what was queued first (a playlist's "Play now"). */
  playNow(tracks: Track[], replaceQueue = false): void {
    if (!tracks.length) return;
    this.checkQueue(tracks, replaceQueue);
    this.#stopped = false;
    if (replaceQueue) this.#queue = [];
    this.#queue.unshift(...tracks);
    if (replaceQueue && this.#shuffleEnabled) this.shuffle();
    this.#userPaused = false;
    if (this.#track) this.#finishTrack(undefined, false, true);
    this.#advance();
  }

  previous(): boolean {
    if (this.#track && (this.elapsed > 3 || !this.#history.length)) {
      this.#trackFrames = 0;
      this.#restart();
      this.#emit({ type: "change" });
      return true;
    }
    const previous = this.#history.pop();
    if (!previous) return this.#track ? this.seek(0) : false;
    this.#stopped = false;
    if (this.#track) this.#queue.unshift(this.#track);
    this.#track = previous;
    this.#trackFrames = 0;
    this.#failStreak = 0;
    this.#restart();
    this.#emit({ type: "trackStart", track: previous });
    this.#emit({ type: "change" });
    return true;
  }

  seek(seconds: number): boolean {
    if (!this.#track?.duration || !Number.isFinite(seconds)) return false;
    this.#trackFrames = Math.floor(
      (Math.max(0, Math.min(seconds, this.#track.duration - 1)) * 1000) / FRAME_MS,
    );
    this.#restart();
    this.#emit({ type: "change" });
    return true;
  }

  setNormalization(enabled: boolean): void {
    this.#normalization = enabled;
    if (this.isActive) this.#restart();
    this.#emit({ type: "change" });
  }

  setLoop(mode: LoopMode): void {
    this.#loop = mode;
    this.#emit({ type: "change" });
  }

  /** Live gain is bounded by the encoder credit window; mute ends speech immediately. */
  setVolume(volume: number): void {
    this.#volume = Math.max(
      0,
      Math.min(100, Number.isFinite(volume) ? Math.round(volume) : this.#volume),
    );
    if (this.#volume === 0) this.#endTalking();
    this.#emit({ type: "change" });
  }

  pause(): void {
    if (this.#userPaused) return;
    this.#userPaused = true;
    this.#applyPause();
  }

  resume(): void {
    if (!this.#userPaused) return;
    this.#userPaused = false;
    this.#applyPause();
  }

  setAutoPaused(paused: boolean): void {
    if (this.#autoPaused === paused) return;
    this.#autoPaused = paused;
    this.#applyPause();
  }

  // ---- internals ----

  #emit(event: PlayerEvent): void {
    if (event.type === "trackStart") {
      this.#recent.unshift(trackKey(event.track.url));
      this.#recent.length = Math.min(this.#recent.length, 100);
    }
    if (
      event.type === "change" &&
      this.#prepared &&
      this.#prepared.track.url !== this.#nextTrack()?.url
    )
      this.#cancelPrepared();
    this.#opts.onEvent?.(event);
  }

  /**
   * A paused song keeps its pipeline: sending stops, the queue fills and the
   * backpressure holds yt-dlp and ffmpeg where they are, so it continues from
   * the same spot. A live radio stream is closed instead and reopened later.
   */
  #applyPause(): void {
    this.#quietFrames = 0;
    this.#silenceReported = false;
    clearTimeout(this.#idleTimer);
    this.#endTalking();
    if (this.paused) {
      this.#cancelPrepared();
      clearTimeout(this.#timer);
      this.#timer = undefined;
      if (!this.#track) this.#teardown();
      else
        this.#idleTimer = setTimeout(() => {
          if (!this.paused) return;
          this.#teardown();
          this.#parked = true;
        }, this.#settings.idleReleaseSeconds * 1000).unref();
    } else {
      this.#parked = false;
      this.#buffering = true;
      this.#bufferingSince = Date.now();
      if (!this.#pipe) this.#restart();
      else this.#ensureTimer();
    }
    this.#emit({ type: "change" });
  }

  /** Moves to the next song; with an empty queue, to the radio or else the default playlist. */
  #advance(): void {
    this.#retries = 0;
    this.#retrying = false;
    this.#prepareFailedUrl = undefined;
    this.#legacyTrackUrl = undefined;
    this.#track = this.#queue.shift();
    if (!this.#track && !this.#radio && this.#defaultList.length) {
      const index = this.#idleIndex();
      this.#track = this.#defaultList[this.#idleOrderFor()[index]!];
      this.#defaultIndex = (index + 1) % this.#defaultList.length;
      // Each pass through a shuffled idle playlist gets a fresh order.
      if (this.#defaultIndex === 0 && this.#shuffleEnabled) this.#idleOrder = [];
    }
    this.#trackFrames = 0;
    if (this.#track) this.#emit({ type: "trackStart", track: this.#track });
    this.#restart(true);
    this.#emit({ type: "change" });
  }

  /** `advance` false means the caller sets up what plays next; a skipped song is not repeated by loop "one". */
  #finishTrack(error: string | undefined, advance: boolean, skipped = false): void {
    const track = this.#track;
    if (!track) return;
    this.#history.push({ ...track });
    if (this.#history.length > 50) this.#history.shift();
    this.#emit({ type: "trackEnd", track, ...(error ? { error } : {}) });
    if (!track.auto && !error && !skipped && this.#loop === "one") this.#queue.unshift(track);
    else if (!track.auto && !error && this.#loop === "all") this.#queue.push(track);
    this.#track = undefined;
    this.#failStreak = error ? this.#failStreak + 1 : 0;
    if (this.#failStreak >= MAX_FAIL_STREAK) {
      this.#opts.log(
        "error",
        `${MAX_FAIL_STREAK} songs failed in a row; stopping. Is yt-dlp working?`,
      );
      this.#teardown();
      this.#emit({ type: "change" });
      return;
    }
    if (advance) this.#advance();
  }

  #teardown(): void {
    this.#kill();
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#endTalking();
  }

  #restart(allowPrepared = false): void {
    this.#teardown();
    if (this.paused) {
      this.#cancelPrepared();
      return;
    }
    if (
      allowPrepared &&
      this.#prepared &&
      this.#prepared.track.url === this.#track?.url &&
      !this.#connectionPaused
    ) {
      this.#pipe = this.#prepared.pipe;
      this.#prepared.release();
      this.#prepared = undefined;
    } else {
      this.#cancelPrepared();
      if (this.#track && !this.#connectionPaused)
        this.#pipe = this.#start("track", this.#track.url, this.elapsed);
      else if (this.#radio && !this.paused) this.#pipe = this.#start("radio", this.#radio.url);
      else return;
    }
    this.#pipe.activatedAt = Date.now();
    this.#buffering = true;
    this.#quietFrames = 0;
    this.#silenceReported = false;
    this.#bufferingSince = Date.now();
    this.#retrying = false;
    this.#ensureTimer();
  }

  #nextTrack(): Track | undefined {
    if (this.#track && !this.#track.auto && this.#loop === "one") return this.#track;
    return (
      this.#queue[0] ??
      (this.#track && !this.#track.auto && this.#loop === "all"
        ? this.#track
        : !this.#radio && this.#defaultList.length
          ? this.#defaultList[this.#idleOrderFor()[this.#idleIndex()]!]
          : undefined)
    );
  }
  /**
   * Play order of the idle playlist as positions in it: the saved order, or with shuffle on an
   * artist-spread random order, rebuilt whenever the list or the shuffle setting changes.
   */
  #idleOrderFor(): number[] {
    if (this.#idleOrder.length !== this.#defaultList.length) {
      const positions = this.#defaultList.map((_, i) => i);
      this.#idleOrder = this.#shuffleEnabled
        ? spreadShuffle(
            positions,
            (i) => artistKey(this.#defaultList[i]!),
            this.#track ? artistKey(this.#track) : undefined,
          )
        : positions;
    }
    return this.#idleOrder;
  }
  /** Next position in the idle play order, passing over songs played recently. */
  #idleIndex(): number {
    const order = this.#idleOrderFor();
    const start = this.#defaultIndex % this.#defaultList.length;
    const recent = new Set(this.#recent.slice(0, this.#settings.avoidRecent));
    for (let n = 0; n < this.#defaultList.length; n++) {
      const index = (start + n) % this.#defaultList.length;
      if (!recent.has(trackKey(this.#defaultList[order[index]!]!.url))) return index;
    }
    return start;
  }
  #cancelPrepared(): void {
    this.#warmSource?.controller.abort();
    this.#warmSource = undefined;
    this.#cancelBudgetWait?.();
    this.#cancelBudgetWait = undefined;
    const prepared = this.#prepared;
    this.#prepared = undefined;
    if (prepared) {
      prepared.release();
      this.#killPipe(prepared.pipe);
    }
  }
  #prepareNext(): void {
    // Resolve only the next URL ahead of time even when full audio prebuffering is off.
    // This avoids another provider lookup at the song boundary without an idle decoder.
    if (
      !this.paused &&
      this.#pipe &&
      this.#track?.duration &&
      this.#opts.resolveSource &&
      this.#track.duration - this.elapsed <= 20
    ) {
      const next = this.#nextTrack();
      if (next && this.#warmSource?.url !== next.url) {
        this.#warmSource?.controller.abort();
        const controller = new AbortController();
        this.#warmSource = { url: next.url, controller };
        void this.#opts.resolveSource(next.url, controller.signal).catch(() => {});
      }
    }
    if (
      this.paused ||
      !this.#pipe ||
      !this.#prebuffer ||
      this.#prepared ||
      !this.#track?.duration ||
      this.#track.duration - this.elapsed > 15
    )
      return;
    const next = this.#nextTrack();
    if (!next || next.url === this.#prepareFailedUrl) return;
    const budget = this.#opts.prebufferBudget ?? prebufferBudget;
    const release = budget.acquire();
    if (!release) {
      this.#cancelBudgetWait ??= budget.onAvailable(() => {
        this.#cancelBudgetWait = undefined;
        this.#prepareNext();
      });
      return;
    }
    this.#cancelBudgetWait?.();
    this.#cancelBudgetWait = undefined;
    try {
      this.#prepared = { track: next, pipe: this.#start("track", next.url, 0, next), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  #retryTrack(reason: string): void {
    this.#lastError = reason;
    if (
      !this.#track ||
      this.#retries >= 2 ||
      /not installed|could not start|private video|unavailable|unsupported url|HTTP Error 40[134]/i.test(
        reason,
      )
    ) {
      this.#retrying = false;
      this.#finishTrack(reason, true);
      return;
    }
    this.#retrying = true;
    this.#retries++;
    this.#cancelPrepared();
    this.#teardown();
    this.#opts.log(
      "warn",
      "Retrying " +
        this.#track.title +
        " at " +
        this.elapsed +
        "s (" +
        this.#retries +
        "/2): " +
        reason,
    );
    this.#restartTimer = setTimeout(() => {
      if (this.#track && !this.paused) this.#restart();
    }, this.#retries * 1000);
    this.#emit({ type: "change" });
  }

  #ensureTimer(delay = 0): void {
    if (this.#timer || this.paused || !this.#pipe) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#tick();
      if (!this.paused && this.#pipe)
        this.#ensureTimer(
          this.#buffering
            ? Math.max(1, 30000 - (Date.now() - this.#bufferingSince))
            : Math.max(1, this.#clockStart + this.#framesSent * FRAME_MS - performance.now()),
        );
    }, delay);
  }
  #wakeBuffer(pipe: Pipeline) {
    if (this.#pipe !== pipe || !this.#buffering || this.paused) return;
    if (pipe.frames.length < PREBUFFER_FRAMES && !pipe.ended) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#ensureTimer();
  }

  #start(kind: "track" | "radio", url: string, offset = 0, preparation?: Track): Pipeline {
    const pipe: Pipeline = {
      kind,
      procs: [],
      startedAt: Date.now(),
      initialTrackFrames: (offset * 1000) / FRAME_MS,
      ended: false,
      failure: undefined,
      frames: [],
      reader: new OggPacketReader(),
      readPaused: false,
      submittedFrames: 0,
      playedFrames: 0,
      levels: [],
    };
    this.#opts.log(
      "info",
      `${preparation ? "Preparing next track" : kind === "track" ? "Song start" : "Radio start"}: ${preparation?.title ?? (kind === "track" ? this.#track?.title : this.#radio?.name)} (${url})`,
    );
    if (kind === "track" && this.#opts.resolveSource && this.#legacyTrackUrl !== url) {
      const controller = new AbortController();
      pipe.sourceController = controller;
      const open = (source: AudioSource | null) => {
        if (controller.signal.aborted || (this.#pipe !== pipe && this.#prepared?.pipe !== pipe))
          return;
        pipe.sourceLookupMs = Date.now() - pipe.startedAt;
        try {
          this.#openPipeline(pipe, url, offset, source);
        } catch {
          if (this.#prepared?.pipe === pipe) {
            this.#prepareFailedUrl = this.#prepared.track.url;
            this.#cancelPrepared();
          } else this.#failed("Audio input could not start");
        }
      };
      void this.#opts.resolveSource(url, controller.signal).then(open, () => open(null));
    } else this.#openPipeline(pipe, url, offset, null);
    return pipe;
  }

  #openPipeline(pipe: Pipeline, url: string, offset: number, source: AudioSource | null): void {
    const { ffmpegPath, ytdlpPath, bitrateKbps } = this.#opts;
    const kind = pipe.kind;
    pipe.sourceMode = source ? "direct" : "pipe";
    const procs = pipe.procs;
    // Audio needs one worker; automatic filter pools scale to every host core and
    // can exhaust a container's PID budget when several tracks prepare at once.
    const quiet = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
    ];
    const pcmOut = [
      "-vn",
      ...(this.#normalization ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : []),
      "-ac",
      String(CHANNELS),
      "-ar",
      String(SAMPLE_RATE),
      "-threads",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ];
    let decoder: ChildProcess;
    if (kind === "track" && source) {
      const headers = Object.entries(source.headers)
        .map(([name, value]) => name + ": " + value + "\r\n")
        .join("");
      decoder = spawn(
        ffmpegPath,
        [
          ...quiet,
          "-rw_timeout",
          "15000000",
          ...(headers ? ["-headers", headers] : []),
          ...(offset > 0 ? ["-ss", String(offset)] : []),
          "-i",
          source.url,
          ...pcmOut,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } else if (kind === "track") {
      // yt-dlp handles the site's headers and signatures; ffmpeg just decodes its output.
      const ytdlp = spawn(
        ytdlpPath,
        ["-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", url],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      decoder = spawn(
        ffmpegPath,
        [...quiet, "-i", "pipe:0", ...(offset > 0 ? ["-ss", String(offset)] : []), ...pcmOut],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      ytdlp.stdout!.pipe(decoder.stdin!);
      procs.push(ytdlp);
    } else {
      const reconnect = [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "10",
      ];
      decoder = spawn(
        ffmpegPath,
        [...quiet, ...reconnect, "-user_agent", "radiospeak/0.3", "-i", url, ...pcmOut],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    }
    const encoder = spawn(
      ffmpegPath,
      [
        ...quiet,
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        `${bitrateKbps}k`,
        "-vbr",
        "on",
        "-application",
        "audio",
        "-compression_level",
        this.#settings.audioProfile === "balanced" ? "5" : "10",
        "-threads",
        "1",
        "-frame_duration",
        String(FRAME_MS),
        "-f",
        "ogg",
        "-page_duration",
        "20000",
        "-flush_packets",
        "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    procs.push(decoder, encoder);
    const gain = new AudioGain(
      () => this.#volume / 100,
      () => pipe.submittedFrames - pipe.playedFrames < ENCODER_CREDIT_FRAMES,
      () => {
        pipe.submittedFrames++;
      },
      (rms, peak, gain) => {
        pipe.levels.push({ rms, peak, gain });
      },
    );
    decoder.stdout!.pipe(gain).pipe(encoder.stdin!);
    for (const p of procs) p.stdin?.on("error", () => {}); // EPIPE when a process is killed first

    pipe.encoderOut = encoder.stdout!;
    pipe.gain = gain;
    const valid = () => this.#pipe === pipe || this.#prepared?.pipe === pipe;
    const failed = (reason: string) => {
      if (this.#prepared?.pipe === pipe) {
        this.#prepareFailedUrl = this.#prepared.track.url;
        this.#cancelPrepared();
      } else if (this.#pipe === pipe) this.#failed(reason);
    };

    let stderrTail = "";
    for (const p of procs) {
      p.stderr!.setEncoding("utf8");
      p.stderr!.on("data", (s: string) => (stderrTail = (stderrTail + s).slice(-2000)));
      p.on("error", (err) => {
        if (!valid()) return;
        const exe = p === procs[0] && kind === "track" && !source ? ytdlpPath : ffmpegPath;
        failed(`${exe} could not start: ${err.message}`);
      });
    }
    gain.on("error", (err) => {
      if (valid()) failed("Audio gain failed: " + err.message);
    });
    const tail = () =>
      stderrTail
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(" | ")
        .replace(/https?:\/\/[^\s]+/g, "[media URL]");

    // yt-dlp or the decoder failing ends the decoder's output; the encoder then
    // finishes normally, so remember the reason for when the queue runs dry.
    for (const p of procs.slice(0, -1)) {
      p.on("exit", (code) => {
        if (valid() && code !== 0 && code !== null) pipe.failure ??= tail() || `exit code ${code}`;
      });
    }

    pipe.encoderOut.on("data", (chunk: Buffer) => {
      if (!valid()) return;
      for (const packet of pipe.reader.push(chunk)) {
        if (!isOpusHeader(packet)) pipe.frames.push(packet);
      }
      if (!pipe.readPaused && pipe.frames.length > QUEUE_HIGH) {
        pipe.readPaused = true;
        pipe.encoderOut?.pause();
      }
      this.#wakeBuffer(pipe);
    });

    encoder.on("close", (code) => {
      if (!valid()) return;
      if (code !== 0) pipe.failure ??= tail() || `encoder exit code ${code}`;
      if (kind === "track") {
        if (pipe.failure && this.#prepared?.pipe === pipe) {
          failed(pipe.failure);
          return;
        }
        // Let the buffered audio play out; #tick finishes the song when it runs dry.
        pipe.ended = true;
        this.#wakeBuffer(pipe);
        return;
      }
      this.#opts.log("warn", `Radio stream ended${pipe.failure ? `: ${pipe.failure}` : ""}`);
      failed(pipe.failure ?? "stream ended");
    });
  }

  /** A provider that rejects direct HTTP still has the established yt-dlp download path. */
  #fallbackSource(pipe: Pipeline): boolean {
    if (
      pipe.kind !== "track" ||
      pipe.sourceMode !== "direct" ||
      pipe.playedFrames > 0 ||
      !this.#track
    )
      return false;
    this.#legacyTrackUrl = this.#track.url;
    this.#opts.invalidateSource?.(this.#track.url);
    this.#opts.log("warn", "Direct audio input was unavailable; using streamed playback.");
    this.#restart();
    this.#emit({ type: "change" });
    return true;
  }

  #failed(reason: string): void {
    const pipe = this.#pipe;
    if (!pipe) return;
    if (this.#fallbackSource(pipe)) return;
    this.#kill();
    if (pipe.kind === "track") {
      this.#retryTrack(reason);
      return;
    }
    // Radio: reconnect, backing off while it keeps failing quickly.
    if (Date.now() - pipe.startedAt > HEALTHY_MS) {
      this.#radioDelayMs = 2000;
      this.#radioFailures = 0;
    }
    this.#radioFailures++;
    if (this.#radioFailures >= 2 && this.#radioFallbacks.some((s) => s.url !== this.#radio?.url)) {
      const index = this.#radioFallbacks.findIndex((s) => s.url === this.#radio?.url);
      const next = this.#radioFallbacks[(index + 1) % this.#radioFallbacks.length]!;
      this.#failoverReason = `${this.#radio?.name}: ${reason}. Switched to ${next.name}`;
      this.#opts.log("warn", this.#failoverReason);
      this.#radio = { ...next };
      this.#radioFailures = 0;
      this.#emit({ type: "change" });
    }
    const delay = this.#radioDelayMs;
    this.#radioDelayMs = Math.min(this.#radioDelayMs * 2, 30_000);
    this.#opts.log("info", `Reconnecting radio in ${delay / 1000}s`);
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      if (!this.#track && this.#radio && !this.paused) this.#restart();
    }, delay);
  }

  #kill(): void {
    const pipe = this.#pipe;
    this.#pipe = undefined;
    if (pipe) this.#killPipe(pipe);
  }
  #killPipe(pipe: Pipeline): void {
    pipe.sourceController?.abort();
    pipe.gain?.destroy();
    pipe.encoderOut?.removeAllListeners("data");
    // Release blocked pipe writes before terminating FFmpeg. On Linux its SIGTERM
    // handler alone can leave it waiting forever for a full output pipe to drain.
    for (const p of pipe.procs) {
      p.stdin?.destroy();
      p.stdout?.destroy();
      p.stderr?.destroy();
      p.kill();
      if (p.exitCode === null && p.signalCode === null) {
        const force = setTimeout(() => {
          if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
        }, 1000).unref();
        p.once("close", () => clearTimeout(force));
      }
    }
  }

  #tick(): void {
    const pipe = this.#pipe;
    if (this.paused) return;
    this.#prepareNext();
    if (!pipe) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }

    if (this.#buffering) {
      const enough =
        pipe.frames.length >= PREBUFFER_FRAMES || (pipe.ended && pipe.frames.length > 0);
      if (!enough) {
        if (pipe.ended && pipe.frames.length === 0) this.#songDone(pipe);
        else if (Date.now() - this.#bufferingSince >= 30_000)
          this.#failed("Audio stream stalled for 30 seconds");
        return;
      }
      this.#buffering = false;
      this.#clockStart = performance.now();
      this.#framesSent = 0;
    }

    const now = performance.now();
    if (now - (this.#clockStart + this.#framesSent * FRAME_MS) > MAX_LATE_MS) {
      // Event loop stalled: re-anchor the clock rather than flooding the server.
      this.#clockStart = now;
      this.#framesSent = 0;
    }

    while (this.#clockStart + this.#framesSent * FRAME_MS <= now) {
      const frame = pipe.frames.shift();
      if (!frame) {
        this.#buffering = true;
        this.#bufferingSince = Date.now();
        this.#endTalking();
        if (pipe.ended) this.#songDone(pipe);
        else {
          this.underruns++;
          this.#totalUnderruns++;
        }
        break;
      }
      pipe.firstFrameMs ??= Date.now() - (pipe.activatedAt ?? pipe.startedAt);
      pipe.playedFrames++;
      const late = Math.max(0, now - (this.#clockStart + this.#framesSent * FRAME_MS));
      this.#deadlineSamples++;
      this.#deadlineTotal += late;
      this.#deadlineMax = Math.max(this.#deadlineMax, late);
      const level = pipe.levels.shift();
      if (level) {
        const db = (v: number) => Math.max(-96, 20 * Math.log10(Math.max(0.00001585, v)));
        this.#level = {
          sourceDb: db(level.rms),
          rmsDb: db(level.rms * level.gain),
          peakDb: db(level.peak * level.gain),
        };
        const silence = this.#settings.silence!;
        this.#quietFrames =
          silence.enabled && this.#volume > 0 && this.#level.sourceDb < silence.thresholdDb
            ? this.#quietFrames + 1
            : 0;
        if (!this.#quietFrames) this.#silenceReported = false;
        if (this.#quietFrames * FRAME_MS >= silence.seconds * 1000 && !this.#silenceReported) {
          this.#silenceReported = true;
          this.#silenceAlert = {
            id: String(Date.now()),
            at: new Date().toISOString(),
            message: `Audio has been below ${silence.thresholdDb} dB for ${silence.seconds} seconds`,
          };
          this.#opts.log("warn", this.#silenceAlert.message);
          this.#emit({ type: "change" });
          if (
            silence.radioFailover &&
            pipe.kind === "radio" &&
            this.#radioFallbacks.some((s) => s.url !== this.#radio?.url)
          ) {
            this.#radioFailures = 1;
            this.#failed("Sustained source silence");
            return;
          }
        }
      }
      pipe.gain?.grantCredit();
      if (this.#volume > 0) {
        this.#talking = true;
        this.#opts.sendFrame(frame);
      } else this.#endTalking();
      this.#framesSent++;
      if (pipe.kind === "track") this.#trackFrames++;
    }

    if (pipe.readPaused && pipe.frames.length < QUEUE_LOW && this.#pipe === pipe) {
      pipe.readPaused = false;
      pipe.encoderOut?.resume();
    }
  }

  /** The song's audio has all been sent. Under a second of it means it never really played. */
  #songDone(pipe: Pipeline): void {
    if (pipe.failure && this.#fallbackSource(pipe)) return;
    this.#kill();
    const premature =
      this.#track?.duration && this.elapsed > 0 && this.elapsed < this.#track.duration - 3;
    if (pipe.failure || premature)
      this.#retryTrack(pipe.failure ?? "Media stream ended before the track finished");
    else this.#finishTrack(undefined, true);
  }

  #endTalking(): void {
    if (!this.#talking) return;
    this.#talking = false;
    this.#opts.sendFrame(new Uint8Array(0));
  }
}
