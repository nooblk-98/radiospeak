import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import OpusScript from "opusscript";
import type { Station } from "./config.ts";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
/** Frames buffered before playback starts or resumes after an underrun. */
const PREBUFFER_FRAMES = 15;
/** Pause ffmpeg's output above this many queued frames, resume below the low mark. */
const QUEUE_HIGH = 150;
const QUEUE_LOW = 50;
/** If the event loop stalls longer than this, drop the backlog of due frames instead of bursting. */
const MAX_LATE_MS = 200;
/** A stream that dies sooner than this counts as a failed URL and the next backup is tried. */
const HEALTHY_MS = 30_000;

/** Something from the queue: a YouTube/SoundCloud/any yt-dlp link, played once. */
export interface Track {
  url: string;
  title: string;
  requestedBy?: string;
}

export type PlayerEvent =
  | { type: "trackStart"; track: Track }
  | { type: "trackEnd"; track: Track; error?: string }
  | { type: "change" };

export interface RadioOptions {
  ffmpegPath: string;
  ytdlpPath: string;
  bitrateKbps: number;
  volume: number;
  /** Called with one 20 ms Opus frame; an empty frame means "stopped talking". */
  sendFrame: (frame: Uint8Array) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  onEvent?: (event: PlayerEvent) => void;
}

interface Source {
  procs: ChildProcess[];
  stdout: Readable;
  startedAt: number;
  /** ffmpeg finished on its own (end of a track). */
  ended: boolean;
}

/**
 * Plays one radio station, interrupted by queued tracks. ffmpeg decodes to PCM,
 * volume is applied here and frames are Opus-encoded just before sending, so a
 * volume change is heard immediately.
 */
export class RadioPlayer {
  #opts: RadioOptions;
  #encoder: OpusScript;
  #station: Station | undefined;
  #urlIndex = 0;
  #failedInARow = 0;
  #track: Track | undefined;
  #queue: Track[] = [];
  #volume: number;
  #gain: number;
  #paused = false;

  #source: Source | undefined;
  #generation = 0;
  #frames: Buffer[] = [];
  #partial: Buffer = Buffer.alloc(0);
  #readPaused = false;
  #buffering = true;
  #clockStart = 0;
  #framesSent = 0;
  #timer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #talking = false;

  constructor(opts: RadioOptions) {
    this.#opts = opts;
    this.#volume = opts.volume;
    this.#gain = opts.volume / 100;
    this.#encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.#encoder.setBitrate(opts.bitrateKbps * 1000);
  }

  /** The selected radio station (kept while a track interrupts it or while paused). */
  get station(): Station | undefined {
    return this.#station;
  }

  get track(): Track | undefined {
    return this.#track;
  }

  get queue(): readonly Track[] {
    return this.#queue;
  }

  get volume(): number {
    return this.#volume;
  }

  /** Paused because nobody is listening. */
  get paused(): boolean {
    return this.#paused;
  }

  /** Something is selected to play (it may be paused). */
  get isActive(): boolean {
    return this.#station !== undefined || this.#track !== undefined;
  }

  /** The stream URL in use, for reading song titles; undefined while a track plays. */
  get streamUrl(): string | undefined {
    if (this.#track || !this.#station) return undefined;
    return this.#urls(this.#station)[this.#urlIndex];
  }

  play(station: Station): void {
    this.#station = station;
    this.#urlIndex = 0;
    this.#failedInARow = 0;
    this.#queue = [];
    if (this.#track) this.#endTrack(undefined, false);
    this.#restart();
    this.#emit({ type: "change" });
  }

  /** Queue a track; it starts now unless another track is already playing. */
  enqueue(track: Track): number {
    this.#queue.push(track);
    if (!this.#track) this.#nextTrack();
    else this.#emit({ type: "change" });
    return this.#queue.length;
  }

  skip(): boolean {
    if (!this.#track) return false;
    this.#endTrack(undefined, true);
    return true;
  }

  clearQueue(): void {
    this.#queue = [];
    this.#emit({ type: "change" });
  }

  stop(): void {
    this.#station = undefined;
    this.#track = undefined;
    this.#queue = [];
    this.#teardown();
    this.#emit({ type: "change" });
  }

  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#teardown();
    this.#emit({ type: "change" });
  }

  /** Resuming restarts the stream; a paused track starts over. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#restart();
    this.#emit({ type: "change" });
  }

  /** Takes effect on the next frame, with a short ramp to avoid clicks. */
  setVolume(volume: number): void {
    this.#volume = volume;
    this.#emit({ type: "change" });
  }

  #urls(station: Station): string[] {
    return [station.url, ...(station.backupUrls ?? [])];
  }

  #emit(event: PlayerEvent): void {
    this.#opts.onEvent?.(event);
  }

  #nextTrack(): void {
    const next = this.#queue.shift();
    this.#track = next;
    if (next) this.#emit({ type: "trackStart", track: next });
    this.#restart();
    this.#emit({ type: "change" });
  }

  /** `advance` false means the caller sets up what plays next. */
  #endTrack(error: string | undefined, advance: boolean): void {
    const track = this.#track;
    if (!track) return;
    this.#track = undefined;
    this.#emit({ type: "trackEnd", track, ...(error ? { error } : {}) });
    if (advance) this.#nextTrack();
  }

  #teardown(): void {
    this.#killSource();
    clearTimeout(this.#restartTimer);
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#frames = [];
    this.#endTalking();
  }

  #restart(): void {
    this.#teardown();
    if (this.#paused) return;
    if (this.#track) this.#startTrack(this.#track);
    else if (this.#station) this.#startStream(this.#station);
    else return;
    this.#timer = setInterval(() => this.#tick(), 5);
  }

  #ffmpegArgs(input: string, network: boolean): string[] {
    return [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...(network
        ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
           "-reconnect_delay_max", "10", "-user_agent", "radiospeak/0.2"]
        : []),
      "-i", input,
      "-vn", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE),
      "-f", "s16le", "pipe:1",
    ];
  }

  #startStream(station: Station): void {
    const url = this.#urls(station)[this.#urlIndex] ?? station.url;
    this.#opts.log("info", `Stream start: ${station.name} (${url})`);
    const ffmpeg = spawn(this.#opts.ffmpegPath, this.#ffmpegArgs(url, true), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#attach([ffmpeg], ffmpeg, "stream");
  }

  #startTrack(track: Track): void {
    this.#opts.log("info", `Track start: ${track.title} (${track.url})`);
    // yt-dlp handles the site's headers and signatures; ffmpeg just decodes its output.
    const ytdlp = spawn(
      this.#opts.ytdlpPath,
      ["-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", track.url],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const ffmpeg = spawn(this.#opts.ffmpegPath, this.#ffmpegArgs("pipe:0", false), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    ytdlp.stdout!.pipe(ffmpeg.stdin!);
    ffmpeg.stdin!.on("error", () => {}); // EPIPE when ffmpeg is killed first
    this.#attach([ytdlp, ffmpeg], ffmpeg, "track");
  }

  #attach(procs: ChildProcess[], ffmpeg: ChildProcess, kind: "stream" | "track"): void {
    const gen = ++this.#generation;
    const source: Source = { procs, stdout: ffmpeg.stdout!, startedAt: Date.now(), ended: false };
    this.#source = source;
    this.#frames = [];
    this.#partial = Buffer.alloc(0);
    this.#buffering = true;
    this.#readPaused = false;

    let stderrTail = "";
    for (const p of procs) {
      p.stderr!.setEncoding("utf8");
      p.stderr!.on("data", (s: string) => (stderrTail = (stderrTail + s).slice(-2000)));
      p.on("error", (err) => {
        if (gen !== this.#generation) return;
        const exe = p === ffmpeg ? this.#opts.ffmpegPath : this.#opts.ytdlpPath;
        this.#opts.log("error", `Failed to start ${exe}: ${err.message}`);
        this.#sourceFailed(kind, `${exe} not available`);
      });
    }

    source.stdout.on("data", (chunk: Buffer) => {
      if (gen !== this.#generation) return;
      let data = this.#partial.length ? Buffer.concat([this.#partial, chunk]) : chunk;
      while (data.length >= FRAME_BYTES) {
        this.#frames.push(Buffer.from(data.subarray(0, FRAME_BYTES)));
        data = data.subarray(FRAME_BYTES);
      }
      this.#partial = Buffer.from(data);
      if (!this.#readPaused && this.#frames.length > QUEUE_HIGH) {
        this.#readPaused = true;
        source.stdout.pause();
      }
    });

    ffmpeg.on("exit", (code, signal) => {
      if (gen !== this.#generation) return;
      const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
      if (kind === "track" && code === 0) {
        // Let the buffered audio play out; #tick ends the track when it runs dry.
        source.ended = true;
        return;
      }
      this.#opts.log("warn", `ffmpeg exited (code=${code} signal=${signal})${tail ? `: ${tail}` : ""}`);
      this.#sourceFailed(kind, tail || `ffmpeg exited with code ${code}`);
    });
  }

  #sourceFailed(kind: "stream" | "track", reason: string): void {
    if (kind === "track") {
      this.#killSource();
      this.#endTrack(reason, true);
      return;
    }
    const station = this.#station;
    if (!station) return;
    const urls = this.#urls(station);
    const healthy = this.#source && Date.now() - this.#source.startedAt > HEALTHY_MS;
    this.#killSource();
    if (healthy) {
      this.#failedInARow = 0;
    } else {
      this.#failedInARow++;
      if (urls.length > 1) {
        this.#urlIndex = (this.#urlIndex + 1) % urls.length;
        this.#opts.log("info", `Switching ${station.name} to URL ${this.#urlIndex + 1}/${urls.length}`);
      }
    }
    // Quick retry while there are untried URLs; back off once every URL has failed.
    const rounds = Math.floor(this.#failedInARow / urls.length);
    const delay = rounds === 0 ? 2000 : Math.min(2000 * 2 ** rounds, 30_000);
    this.#opts.log("info", `Reconnecting to stream in ${delay / 1000}s`);
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      if (this.#station === station && !this.#track && !this.#paused) this.#restart();
    }, delay);
  }

  #killSource(): void {
    this.#generation++;
    const source = this.#source;
    this.#source = undefined;
    if (!source) return;
    source.stdout.removeAllListeners("data");
    for (const p of source.procs) p.kill();
  }

  #tick(): void {
    const source = this.#source;
    if (this.#buffering) {
      const enough = this.#frames.length >= PREBUFFER_FRAMES || (source?.ended && this.#frames.length > 0);
      if (!enough) {
        if (source?.ended && this.#frames.length === 0) this.#endTrack(undefined, true);
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
      const pcm = this.#frames.shift();
      if (!pcm) {
        this.#buffering = true;
        this.#endTalking();
        if (source?.ended) this.#endTrack(undefined, true);
        break;
      }
      this.#send(this.#encode(pcm));
      this.#framesSent++;
    }

    if (this.#readPaused && this.#frames.length < QUEUE_LOW && source) {
      this.#readPaused = false;
      source.stdout.resume();
    }
  }

  #encode(pcm: Buffer): Buffer {
    const target = this.#volume / 100;
    const from = this.#gain;
    if (from !== 1 || target !== 1) {
      const samples = FRAME_SAMPLES * CHANNELS;
      for (let i = 0; i < samples; i++) {
        const g = from + ((target - from) * i) / samples;
        const v = Math.round(pcm.readInt16LE(i * 2) * g);
        pcm.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
      }
    }
    this.#gain = target;
    return this.#encoder.encode(pcm, FRAME_SAMPLES);
  }

  #send(frame: Uint8Array): void {
    this.#talking = true;
    this.#opts.sendFrame(frame);
  }

  #endTalking(): void {
    if (!this.#talking) return;
    this.#talking = false;
    this.#opts.sendFrame(new Uint8Array(0));
  }
}
