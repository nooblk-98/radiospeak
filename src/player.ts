import { spawn, type ChildProcess } from "node:child_process";
import { Transform, type TransformCallback, type Readable } from "node:stream";
import { OggPacketReader, isOpusHeader } from "./ogg.ts";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
/** Opus frames buffered before playback starts or resumes after an underrun. */
const PREBUFFER_FRAMES = 15;
/**
 * Above this many queued frames the encoder's output is paused, which backs up
 * through the whole pipeline (encoder, volume, decoder, yt-dlp). Kept small so a
 * volume change is heard within about a second.
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
  /** From the default playlist, played only while nobody has requested anything. */
  auto?: boolean;
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
}

/** Applies volume to s16le PCM, ramping from the previous level to avoid clicks. */
class VolumeTransform extends Transform {
  #carry: Buffer = Buffer.alloc(0);
  #gain: number;
  #target: () => number;

  constructor(target: () => number) {
    super();
    this.#target = target;
    this.#gain = target();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    const data = this.#carry.length ? Buffer.concat([this.#carry, chunk]) : chunk;
    const usable = data.length - (data.length % 4); // whole stereo samples only
    this.#carry = Buffer.from(data.subarray(usable));
    if (usable === 0) return done();

    // A fresh allocation is aligned, so it can be viewed as 16-bit samples.
    const out = Buffer.alloc(usable);
    data.copy(out, 0, 0, usable);
    const from = this.#gain;
    const to = this.#target();
    if (from !== 1 || to !== 1) {
      const s = new Int16Array(out.buffer, out.byteOffset, usable / 2);
      const n = s.length;
      const step = (to - from) / n;
      let g = from;
      for (let i = 0; i < n; i++, g += step) {
        const v = s[i]! * g;
        s[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
    this.#gain = to;
    done(null, out);
  }
}

interface Pipeline {
  kind: "track" | "radio";
  procs: ChildProcess[];
  encoderOut: Readable;
  startedAt: number;
  initialTrackFrames: number;
  /** The encoder finished: everything left is in the frame queue. */
  ended: boolean;
  /** The decoder or yt-dlp failed; the reason, for reporting. */
  failure: string | undefined;
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
  #generation = 0;
  #frames: Buffer[] = [];
  #reader = new OggPacketReader();
  #readPaused = false;
  #buffering = true;
  #clockStart = 0;
  #framesSent = 0;
  #trackFrames = 0;
  #timer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #radioDelayMs = 2000;
  #talking = false;
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
  get normalization(): boolean { return this.#normalization; }
  get shuffleEnabled(): boolean { return this.#shuffleEnabled; }
  get canGoBack(): boolean { return this.#history.length > 0 || !!this.#track; }
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
  get connectionPaused(): boolean { return this.#connectionPaused; }

  snapshot(): PlaybackSnapshot {
    return {
      track: this.#track ? { ...this.#track } : null, queue: this.#queue.map(t => ({ ...t })),
      elapsed: this.elapsed, radio: this.#radio ? { ...this.#radio } : null,
      defaultName: this.#defaultName ?? null, defaultIndex: this.#defaultIndex,
      volume: this.#volume, loop: this.#loop, shuffle: this.#shuffleEnabled,
      normalization: this.#normalization, userPaused: this.#userPaused, stopped: this.#stopped,
    };
  }

  /** Restore before connecting; audio starts only once the transport resumes. */
  restore(saved: PlaybackSnapshot): void {
    const validTrack = (t: Track) => t && typeof t.url === "string" && /^https?:\/\//i.test(t.url) && typeof t.title === "string";
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.every(validTrack)
      || (saved.track !== null && !validTrack(saved.track))
      || !Number.isFinite(saved.elapsed) || saved.elapsed < 0
      || !Number.isInteger(saved.defaultIndex) || saved.defaultIndex < 0
      || !Number.isFinite(saved.volume) || !["off", "all", "one"].includes(saved.loop)
      || (saved.radio !== null && (!saved.radio || typeof saved.radio.url !== "string" || !/^https?:\/\//i.test(saved.radio.url)))) {
      throw new Error("Invalid playback checkpoint");
    }
    this.#teardown();
    this.#track = saved.stopped ? undefined : saved.track ?? undefined;
    this.#queue = saved.stopped ? [] : saved.queue.map(t => ({ ...t }));
    const elapsed = this.#track?.duration ? Math.min(saved.elapsed, Math.max(0, this.#track.duration - 1)) : saved.elapsed;
    this.#trackFrames = this.#track ? Math.floor(elapsed * 1000 / FRAME_MS) : 0;
    this.#radio = saved.stopped ? undefined : saved.radio ?? undefined;
    this.#defaultName = saved.defaultName ?? undefined;
    this.#defaultIndex = saved.defaultIndex;
    this.#volume = Math.max(0, Math.min(100, saved.volume));
    this.#loop = saved.loop;
    this.#shuffleEnabled = !!saved.shuffle;
    this.#normalization = !!saved.normalization;
    this.#userPaused = !!saved.userPaused;
    this.#stopped = !!saved.stopped;
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
  /** Seconds into the current song. */
  get elapsed(): number {
    return Math.floor((this.#trackFrames * FRAME_MS) / 1000);
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
    const samePlace = name !== undefined && name === this.#defaultName && tracks.length > 0;
    this.#defaultList = tracks.map((t) => ({ ...t, auto: true }));
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
    if (!this.#track) {
      if (!stream && !this.#stopped) this.#advance();
      else this.#restart();
    }
    this.#emit({ type: "change" });
  }

  stop(): void {
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
    if (!Number.isInteger(position) || position < 1 || position > this.#queue.length) return undefined;
    const [removed] = this.#queue.splice(position - 1, 1);
    if (removed) this.#emit({ type: "change" });
    return removed;
  }

  shuffle(): void {
    const q = this.#queue;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j]!, q[i]!];
    }
    this.#emit({ type: "change" });
  }

  setShuffle(enabled: boolean): void {
    this.#shuffleEnabled = enabled;
    if (enabled) this.shuffle();
    else this.#emit({ type: "change" });
  }

  moveAt(from: number, to: number): boolean {
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= this.#queue.length)) return false;
    this.#queue.splice(to - 1, 0, this.#queue.splice(from - 1, 1)[0]!);
    this.#emit({ type: "change" });
    return true;
  }

  playNow(tracks: Track[]): void {
    if (!tracks.length) return;
    this.#stopped = false;
    this.#queue.unshift(...tracks);
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
    this.#trackFrames = Math.floor(Math.max(0, Math.min(seconds, this.#track.duration - 1)) * 1000 / FRAME_MS);
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

  /** Heard within about a second (the buffered audio already has the old volume). */
  setVolume(volume: number): void {
    this.#volume = volume;
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
    this.#opts.onEvent?.(event);
  }

  /**
   * A paused song keeps its pipeline: sending stops, the queue fills and the
   * backpressure holds yt-dlp and ffmpeg where they are, so it continues from
   * the same spot. A live radio stream is closed instead and reopened later.
   */
  #applyPause(): void {
    this.#endTalking();
    if (this.paused) {
      if (!this.#track) this.#teardown();
    } else {
      this.#buffering = true;
      if (!this.#pipe) this.#restart();
      else this.#ensureTimer();
    }
    this.#emit({ type: "change" });
  }

  /** Moves to the next song; with an empty queue, to the radio or else the default playlist. */
  #advance(): void {
    this.#track = this.#queue.shift();
    if (!this.#track && !this.#radio && this.#defaultList.length) {
      this.#track = this.#defaultList[this.#defaultIndex % this.#defaultList.length];
      this.#defaultIndex = (this.#defaultIndex + 1) % this.#defaultList.length;
    }
    this.#trackFrames = 0;
    if (this.#track) this.#emit({ type: "trackStart", track: this.#track });
    this.#restart();
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
      this.#opts.log("error", `${MAX_FAIL_STREAK} songs failed in a row; stopping. Is yt-dlp working?`);
      this.#teardown();
      this.#emit({ type: "change" });
      return;
    }
    if (advance) this.#advance();
  }

  #teardown(): void {
    this.#kill();
    clearTimeout(this.#restartTimer);
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#frames = [];
    this.#endTalking();
  }

  #restart(): void {
    this.#teardown();
    if (this.#track && !this.#connectionPaused) this.#start("track", this.#track.url);
    else if (this.#radio && !this.paused) this.#start("radio", this.#radio.url);
    else return;
    this.#ensureTimer();
  }

  #ensureTimer(): void {
    this.#timer ??= setInterval(() => this.#tick(), 5);
  }

  #start(kind: "track" | "radio", url: string): void {
    const gen = ++this.#generation;
    const { ffmpegPath, ytdlpPath, bitrateKbps } = this.#opts;
    this.#opts.log("info", `${kind === "track" ? "Song" : "Radio"} start: ${kind === "track" ? this.#track?.title : this.#radio?.name} (${url})`);

    const procs: ChildProcess[] = [];
    const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin"];
    const pcmOut = ["-vn", ...(this.#normalization ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : []), "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"];
    let decoder: ChildProcess;
    if (kind === "track") {
      // yt-dlp handles the site's headers and signatures; ffmpeg just decodes its output.
      const ytdlp = spawn(
        ytdlpPath,
        ["-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", url],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      decoder = spawn(ffmpegPath, [...quiet, "-i", "pipe:0", ...(this.elapsed > 0 ? ["-ss", String(this.elapsed)] : []), ...pcmOut], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      ytdlp.stdout!.pipe(decoder.stdin!);
      procs.push(ytdlp);
    } else {
      const reconnect = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10"];
      decoder = spawn(ffmpegPath, [...quiet, ...reconnect, "-user_agent", "radiospeak/0.3", "-i", url, ...pcmOut], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    }
    const encoder = spawn(
      ffmpegPath,
      [
        ...quiet,
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "pipe:0",
        "-c:a", "libopus", "-b:a", `${bitrateKbps}k`, "-vbr", "on", "-application", "audio",
        "-frame_duration", String(FRAME_MS),
        "-f", "ogg", "-page_duration", "20000", "-flush_packets", "1", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    procs.push(decoder, encoder);
    decoder.stdout!.pipe(new VolumeTransform(() => this.#volume / 100)).pipe(encoder.stdin!);
    for (const p of procs) p.stdin?.on("error", () => {}); // EPIPE when a process is killed first

    const pipe: Pipeline = { kind, procs, encoderOut: encoder.stdout!, startedAt: Date.now(), initialTrackFrames: this.#trackFrames, ended: false, failure: undefined };
    this.#pipe = pipe;
    this.#frames = [];
    this.#reader.reset();
    this.#buffering = true;
    this.#readPaused = false;

    let stderrTail = "";
    for (const p of procs) {
      p.stderr!.setEncoding("utf8");
      p.stderr!.on("data", (s: string) => (stderrTail = (stderrTail + s).slice(-2000)));
      p.on("error", (err) => {
        if (gen !== this.#generation) return;
        const exe = p === procs[0] && kind === "track" ? ytdlpPath : ffmpegPath;
        this.#failed(`${exe} could not start: ${err.message}`);
      });
    }
    const tail = () => stderrTail.trim().split(/\r?\n/).slice(-2).join(" | ");

    // yt-dlp or the decoder failing ends the decoder's output; the encoder then
    // finishes normally, so remember the reason for when the queue runs dry.
    for (const p of procs.slice(0, -1)) {
      p.on("exit", (code) => {
        if (gen === this.#generation && code !== 0 && code !== null) pipe.failure ??= tail() || `exit code ${code}`;
      });
    }

    pipe.encoderOut.on("data", (chunk: Buffer) => {
      if (gen !== this.#generation) return;
      for (const packet of this.#reader.push(chunk)) {
        if (!isOpusHeader(packet)) this.#frames.push(packet);
      }
      if (!this.#readPaused && this.#frames.length > QUEUE_HIGH) {
        this.#readPaused = true;
        pipe.encoderOut.pause();
      }
    });

    encoder.on("exit", (code) => {
      if (gen !== this.#generation) return;
      if (code !== 0) pipe.failure ??= tail() || `encoder exit code ${code}`;
      if (kind === "track") {
        // Let the buffered audio play out; #tick finishes the song when it runs dry.
        pipe.ended = true;
        return;
      }
      this.#opts.log("warn", `Radio stream ended${pipe.failure ? `: ${pipe.failure}` : ""}`);
      this.#failed(pipe.failure ?? "stream ended");
    });
  }

  #failed(reason: string): void {
    const pipe = this.#pipe;
    if (!pipe) return;
    this.#kill();
    if (pipe.kind === "track") {
      this.#finishTrack(reason, true);
      return;
    }
    // Radio: reconnect, backing off while it keeps failing quickly.
    if (Date.now() - pipe.startedAt > HEALTHY_MS) this.#radioDelayMs = 2000;
    const delay = this.#radioDelayMs;
    this.#radioDelayMs = Math.min(this.#radioDelayMs * 2, 30_000);
    this.#opts.log("info", `Reconnecting radio in ${delay / 1000}s`);
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      if (!this.#track && this.#radio && !this.paused) this.#restart();
    }, delay);
  }

  #kill(): void {
    this.#generation++;
    const pipe = this.#pipe;
    this.#pipe = undefined;
    if (!pipe) return;
    pipe.encoderOut.removeAllListeners("data");
    for (const p of pipe.procs) p.kill();
  }

  #tick(): void {
    const pipe = this.#pipe;
    if (this.paused) return;
    if (!pipe) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      return;
    }

    if (this.#buffering) {
      const enough = this.#frames.length >= PREBUFFER_FRAMES || (pipe.ended && this.#frames.length > 0);
      if (!enough) {
        if (pipe.ended && this.#frames.length === 0) this.#songDone(pipe);
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
      const frame = this.#frames.shift();
      if (!frame) {
        this.#buffering = true;
        this.#endTalking();
        if (pipe.ended) this.#songDone(pipe);
        else this.underruns++;
        break;
      }
      this.#talking = true;
      this.#opts.sendFrame(frame);
      this.#framesSent++;
      if (pipe.kind === "track") this.#trackFrames++;
    }

    if (this.#readPaused && this.#frames.length < QUEUE_LOW && this.#pipe === pipe) {
      this.#readPaused = false;
      pipe.encoderOut.resume();
    }
  }

  /** The song's audio has all been sent. Under a second of it means it never really played. */
  #songDone(pipe: Pipeline): void {
    this.#kill();
    const failed = pipe.failure && this.#trackFrames - pipe.initialTrackFrames < 50;
    this.#finishTrack(failed ? pipe.failure : undefined, true);
  }

  #endTalking(): void {
    if (!this.#talking) return;
    this.#talking = false;
    this.#opts.sendFrame(new Uint8Array(0));
  }
}
