/** Short-lived, memory-only playback URLs. Signed URLs and headers never enter saved tracks. */
import { execFile } from "node:child_process";
import { trackKey } from "../domain/track-key.ts";
import { TaskPool } from "./task-pool.ts";

export interface AudioSource {
  url: string;
  headers: Record<string, string>;
}
type Loader = (path: string, url: string, signal: AbortSignal) => Promise<AudioSource | null>;

const safeUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Full metadata lookups often already contain the selected audio format. Reuse it. */
function sourceFromInfo(info: Record<string, any>): AudioSource | null {
  const playable = (format: Record<string, any>) =>
    safeUrl(format.url) && ["http", "https", "m3u8", "m3u8_native"].includes(format.protocol);
  const formats = [
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
    ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
    ...(Array.isArray(info.formats) ? [...info.formats].reverse() : []),
  ];
  const format =
    formats.find(
      (item) => item && item.vcodec === "none" && item.acodec !== "none" && playable(item),
    ) ?? (playable(info) && info.acodec !== "none" ? info : null);
  if (!format) return null;
  const headers = Object.fromEntries(
    Object.entries({ ...info.http_headers, ...format.http_headers }).filter(
      ([name, value]) =>
        /^[A-Za-z0-9-]+$/.test(name) && typeof value === "string" && !/[\r\n]/.test(value),
    ),
  ) as Record<string, string>;
  return { url: format.url, headers };
}

function extract(path: string, url: string, signal: AbortSignal): Promise<AudioSource | null> {
  return new Promise((accept, reject) => {
    execFile(
      path,
      [
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--dump-single-json",
        "--",
        url,
      ],
      { signal, timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (signal.aborted) return reject(signal.reason);
        // Unsupported extraction falls back to the existing yt-dlp download pipeline.
        if (error) return accept(null);
        try {
          accept(sourceFromInfo(JSON.parse(stdout)));
        } catch {
          accept(null);
        }
      },
    );
  });
}

export class AudioSources {
  #cache = new Map<string, { source: AudioSource | null; until: number }>();
  #flights = new Map<
    string,
    { controller: AbortController; users: Set<symbol>; promise: Promise<AudioSource | null> }
  >();
  #pool = new TaskPool(2);
  #load: Loader;
  constructor(load: Loader = extract) {
    this.#load = load;
  }
  get stats() {
    return { ...this.#pool.stats, cached: this.#cache.size, shared: this.#flights.size };
  }
  invalidate(path: string, url: string): void {
    this.#cache.delete(path + "|" + trackKey(url));
  }
  remember(path: string, url: string, info: Record<string, any>): void {
    const source = sourceFromInfo(info);
    if (source) this.#store(path + "|" + trackKey(url), source);
  }

  #store(key: string, source: AudioSource | null): void {
    const expiry = source ? Number(new URL(source.url).searchParams.get("expire")) * 1000 : 0;
    const until = Math.min(
      Date.now() + (source ? 5 * 60_000 : 30_000),
      expiry > 0 ? expiry - 60_000 : Infinity,
    );
    this.#cache.set(key, { source: this.#copy(source), until });
    while (this.#cache.size > 100) this.#cache.delete(this.#cache.keys().next().value!);
  }

  async resolve(path: string, url: string, signal: AbortSignal): Promise<AudioSource | null> {
    signal.throwIfAborted();
    // Ordinary audio files already have a seekable HTTP input; no extractor is needed.
    if (safeUrl(url) && /\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(url))
      return { url, headers: {} };
    const key = path + "|" + trackKey(url);
    const cached = this.#cache.get(key);
    if (cached && cached.until > Date.now()) return this.#copy(cached.source);
    this.#cache.delete(key);
    let flight = this.#flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const users = new Set<symbol>();
      const entry = { controller, users, promise: Promise.resolve<AudioSource | null>(null) };
      entry.promise = this.#pool
        .run(() => this.#load(path, url, controller.signal), controller.signal)
        .then((source) => {
          if (controller.signal.aborted) return null;
          this.#store(key, source);
          return source;
        })
        .finally(() => {
          if (this.#flights.get(key) === entry) this.#flights.delete(key);
        });
      this.#flights.set(key, entry);
      flight = entry;
    }
    const current = flight;
    const user = Symbol();
    current.users.add(user);
    return new Promise((accept, reject) => {
      const release = () => {
        signal.removeEventListener("abort", cancel);
        current.users.delete(user);
        if (!current.users.size && this.#flights.get(key) === current) current.controller.abort();
      };
      const cancel = () => {
        release();
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      current.promise.then(
        (source) => {
          release();
          if (!signal.aborted) accept(this.#copy(source));
        },
        (error) => {
          release();
          reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  }

  #copy(source: AudioSource | null): AudioSource | null {
    return source ? { url: source.url, headers: { ...source.headers } } : null;
  }
}

export const audioSources = new AudioSources();
