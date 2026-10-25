import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { OggPacketReader, isOpusHeader } from "./ogg.ts";
import type { Station } from "./config.ts";

const FRAME_MS = 20;
/** Frames buffered before playback starts or resumes after an underrun. */
const PREBUFFER_FRAMES = 15;
/** Pause ffmpeg's output above this many queued frames, resume below the low mark. */
const QUEUE_HIGH = 150;
const QUEUE_LOW = 50;
/** If the event loop stalls longer than this, drop the backlog of due frames instead of bursting. */
const MAX_LATE_MS = 200;

export interface RadioOptions {
  ffmpegPath: string;
  bitrateKbps: number;
  volume: number;
  /** Called with one 20 ms Opus frame; an empty frame means "stopped talking". */
  sendFrame: (frame: Uint8Array) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

type Ffmpeg = ChildProcessByStdio<null, Readable, Readable>;

export class RadioPlayer {
  #opts: RadioOptions;
  #station: Station | undefined;
  #volume: number;
  #proc: Ffmpeg | undefined;
  #generation = 0;
  #queue: Buffer[] = [];
  #reader = new OggPacketReader();
  #paused = false;
  #buffering = true;
  #clockStart = 0;
  #framesSent = 0;
  #timer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartDelayMs = 2000;
  #startedAt = 0;
  #talking = false;

  constructor(opts: RadioOptions) {
    this.#opts = opts;
    this.#volume = opts.volume;
  }

  get station(): Station | undefined {
    return this.#station;
  }

  get volume(): number {
    return this.#volume;
  }

  get isPlaying(): boolean {
    return this.#station !== undefined;
  }

  play(station: Station): void {
    this.#station = station;
    this.#restartDelayMs = 2000;
    this.#startProcess();
    this.#ensureTimer();
  }

  stop(): void {
    this.#station = undefined;
    this.#killProcess();
    clearTimeout(this.#restartTimer);
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#queue = [];
    this.#endTalking();
  }

  /** Changing volume restarts ffmpeg with the new filter; there is a short gap. */
  setVolume(volume: number): void {
    this.#volume = volume;
    if (this.#station) this.#startProcess();
  }

  #startProcess(): void {
    this.#killProcess();
    clearTimeout(this.#restartTimer);
    const station = this.#station;
    if (!station) return;

    const gen = ++this.#generation;
    this.#queue = [];
    this.#reader.reset();
    this.#buffering = true;
    this.#paused = false;
    this.#startedAt = Date.now();

    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
      "-reconnect_delay_max", "10",
      "-user_agent", "radiospeak/0.1",
      "-i", station.url,
      "-vn",
      "-af", `volume=${(this.#volume / 100).toFixed(2)}`,
      "-ac", "2", "-ar", "48000",
      "-c:a", "libopus", "-b:a", `${this.#opts.bitrateKbps}k`,
      "-vbr", "on", "-application", "audio", "-frame_duration", String(FRAME_MS),
      "-f", "ogg", "-page_duration", "100000", "-flush_packets", "1",
      "pipe:1",
    ];

    this.#opts.log("info", `ffmpeg start: ${station.name} (${station.url}) vol=${this.#volume}`);
    const proc: Ffmpeg = spawn(this.#opts.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.#proc = proc;

    let stderrTail = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (s: string) => {
      stderrTail = (stderrTail + s).slice(-2000);
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      if (gen !== this.#generation) return;
      for (const packet of this.#reader.push(chunk)) {
        if (!isOpusHeader(packet)) this.#queue.push(packet);
      }
      if (!this.#paused && this.#queue.length > QUEUE_HIGH) {
        this.#paused = true;
        proc.stdout.pause();
      }
    });

    proc.on("error", (err) => {
      if (gen !== this.#generation) return;
      this.#opts.log("error", `ffmpeg failed to start (${this.#opts.ffmpegPath}): ${err.message}`);
      this.#scheduleRestart();
    });

    proc.on("exit", (code, signal) => {
      if (gen !== this.#generation) return;
      this.#proc = undefined;
      const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
      this.#opts.log("warn", `ffmpeg exited (code=${code} signal=${signal})${tail ? `: ${tail}` : ""}`);
      this.#scheduleRestart();
    });
  }

  #scheduleRestart(): void {
    if (!this.#station) return;
    // A stream that played for a while gets a quick retry; repeated failures back off.
    if (Date.now() - this.#startedAt > 30_000) this.#restartDelayMs = 2000;
    const delay = this.#restartDelayMs;
    this.#restartDelayMs = Math.min(this.#restartDelayMs * 2, 30_000);
    this.#opts.log("info", `Reconnecting to stream in ${delay / 1000}s`);
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => this.#startProcess(), delay);
  }

  #killProcess(): void {
    this.#generation++;
    if (this.#proc) {
      this.#proc.stdout.removeAllListeners("data");
      this.#proc.kill();
      this.#proc = undefined;
    }
  }

  #ensureTimer(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 5);
  }

  #tick(): void {
    if (this.#buffering) {
      if (this.#queue.length < PREBUFFER_FRAMES) return;
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
      const frame = this.#queue.shift();
      if (!frame) {
        this.#buffering = true;
        this.#endTalking();
        break;
      }
      this.#send(frame);
      this.#framesSent++;
    }

    if (this.#paused && this.#queue.length < QUEUE_LOW && this.#proc) {
      this.#paused = false;
      this.#proc.stdout.resume();
    }
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
