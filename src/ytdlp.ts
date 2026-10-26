import { execFile } from "node:child_process";
import type { Track } from "./player.ts";
import { TaskPool } from "./task-pool.ts";

export interface Resolved {
  tracks: Track[];
  playlist?: string;
  skipped?: string[];
  entries?: MediaEntry[];
  total?: number;
}
export interface MediaEntry { index: number; track?: Track; error?: string }
export interface ResolveOptions {
  maxItems: number;
  results?: number;
  wholePlaylist?: boolean;
  source?: "youtube" | "soundcloud";
  signal?: AbortSignal;
  partial?: boolean;
  startIndex?: number;
  fresh?: boolean;
  onEntry?: (entry: MediaEntry) => void;
  onProgress?: (progress: { processed: number; total: number | null; title: string }) => void;
}
const pool = new TaskPool(2);
const cache = new Map<string, { until: number; result: Resolved }>();
interface Consumer { options: ResolveOptions; fail: (error: unknown) => void }
interface Flight { controller: AbortController; consumers: Set<Consumer>; promise: Promise<Resolved>; settled: boolean }
const flights = new Map<string, Flight>();
export const mediaStats = () => ({ ...pool.stats, cachedSearches: cache.size, sharedLookups: flights.size });
const isUrl = (s: string) => /^https?:\/\//i.test(s);
function mediaEntry(entry: Record<string, any>, index: number): MediaEntry {
  const title = String(entry.title ?? "").trim(), link = entry.webpage_url || entry.url;
  if (!link || !isUrl(link) || /^\[(private|deleted) video\]$/i.test(title)) return { index, error: title || "Unavailable entry" };
  const seconds = Number(entry.duration), thumbnail = entry.thumbnail ?? entry.thumbnails?.at(-1)?.url;
  const artist = entry.artist || entry.uploader || entry.channel;
  return { index, track: { url: link, title: title || link,
    ...(Number.isFinite(seconds) && seconds > 0 ? { duration: Math.round(seconds) } : {}),
    ...(artist ? { artist: String(artist) } : {}), ...(thumbnail ? { thumbnail: String(thumbnail) } : {}) } };
}
function isSingleVideo(link: string): boolean {
  try {
    const url = new URL(link);
    return url.hostname === "youtu.be" || url.searchParams.has("v");
  } catch { return false; }
}
function run(path: string, args: string[], options: ResolveOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    let progressBuffer = "", processed = 0;
    const child = execFile(path, args, {
      timeout: 90_000, signal: options.signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }, (err, stdout, stderr) => {
      if (options.signal?.aborted) return reject(options.signal.reason);
      if (err && !(options.partial && stdout.includes("T\t"))) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("yt-dlp is not installed"));
        if (err.killed) return reject(new Error("Media lookup took too long to answer"));
        const msg = stderr.trim().split(/\r?\n/).pop() || err.message;
        return reject(new Error(msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "")));
      }
      accept({ stdout, stderr });
    });
    if (options.onProgress || options.onEntry) child.stdout?.on("data", (chunk: Buffer | string) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("T\t")) continue;
        try {
          const entry = JSON.parse(line.slice(2));
          processed++;
          const index = Number(entry.playlist_index) || (options.startIndex ?? 1) + processed - 1;
          options.onEntry?.(mediaEntry(entry,index));
          const total = Number(entry.playlist_count ?? entry.n_entries);
          options.onProgress?.({ processed, total: total > 0 ? total : null, title: String(entry.title ?? "") });
        } catch { /* incomplete or unavailable entry */ }
      }
    });
  });
}
export function playlistId(url: string): string | undefined {
  try { return new URL(url).searchParams.get("list") ?? undefined; } catch { return undefined; }
}
async function lookup(path: string, input: string, options: ResolveOptions): Promise<Resolved> {
  let text = input.trim();
  if (!text) throw new Error("Nothing to look up");
  options.signal?.throwIfAborted();
  const url = isUrl(text), list = url ? playlistId(text) : undefined;
  if (options.wholePlaylist && list) text = "https://www.youtube.com/playlist?list=" + list;
  const target = url ? text : (options.source === "soundcloud" ? "scsearch" : "ytsearch") + (options.results ?? 1) + ":" + text;
  const args = [
    "--flat-playlist", "--skip-download", "--no-warnings", "--newline", "--encoding", "utf-8",
    "--playlist-start", String(options.startIndex ?? 1), "--playlist-end", String((options.startIndex ?? 1) + options.maxItems - 1), "--print", "T\t%()j", "--print", "playlist:P\t%(title|)s",
    ...(options.partial ? ["--ignore-errors"] : []),
    ...(url && isSingleVideo(text) ? ["--no-playlist"] : []), "--", target,
  ];
  const { stdout, stderr } = await pool.run(() => run(path,args,options),options.signal);
  const tracks: Track[] = [], skipped: string[] = [], entries: MediaEntry[] = [];
  let total: number | undefined;
  let playlist: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("P\t")) { playlist = line.slice(2).trim() || undefined; continue; }
    if (!line.startsWith("T\t")) continue;
    try {
      const entry = JSON.parse(line.slice(2));
      const count = Number(entry.playlist_count ?? entry.n_entries);
      if (count > 0) total = count;
      const item = mediaEntry(entry,Number(entry.playlist_index) || (options.startIndex ?? 1) + entries.length);
      entries.push(item);
      if (item.track) tracks.push(item.track); else skipped.push(item.error!);
    } catch { skipped.push("Invalid media entry"); }
  }
  for (const error of stderr.split(/\r?\n/).filter(s=>s.startsWith("ERROR:"))) {
    if (!skipped.includes(error)) skipped.push(error.slice(7).slice(0,300));
  }
  if (!tracks.length && !(options.partial && (entries.length > 0 || ((options.startIndex ?? 1) > 1 && !stderr.includes("ERROR:"))))) throw new Error(skipped[0] || (url ? "Nothing playable at that link" : 'Nothing found for "' + text + '"'));
  return { tracks, entries, ...(total ? { total } : {}), ...(url && tracks.length > 1 && playlist ? { playlist } : {}), ...(skipped.length ? { skipped } : {}) };
}
/** Identical consumers share work; cancelling one does not cancel another's lookup. */
export async function resolve(path: string, input: string, options: ResolveOptions): Promise<Resolved> {
  options.signal?.throwIfAborted();
  const text = input.trim();
  const key = JSON.stringify([path,isUrl(text) ? text : text.toLowerCase(),options.source,options.results,options.maxItems,options.wholePlaylist,!!options.partial,options.startIndex ?? 1]);
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.until > Date.now()) {
    const result = structuredClone(cached.result);
    result.entries?.forEach(e => options.onEntry?.(e));
    options.onProgress?.({ processed: result.entries?.length ?? result.tracks.length, total: result.total ?? null, title: result.tracks.at(-1)?.title ?? "" });
    return result;
  }
  let flight = flights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController(), consumers = new Set<Consumer>();
    const notify = (kind: "onEntry" | "onProgress", value: any) => {
      for (const consumer of [...consumers]) try { consumer.options[kind]?.(structuredClone(value)); } catch (error) { consumer.fail(error); }
    };
    flight = { controller, consumers, settled: false, promise: undefined! };
    const work = flight;
    work.promise = Promise.resolve().then(() => lookup(path,input,{ ...options, signal: controller.signal,
      onEntry: value => notify("onEntry",value), onProgress: value => notify("onProgress",value) })).then(result => {
      if (options.maxItems <= 100) {
        for (const [id,value] of cache) if (value.until <= Date.now()) cache.delete(id);
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key,{ until: Date.now() + (isUrl(text) ? 120_000 : 60_000), result: structuredClone(result) });
      }
      return result;
    }).finally(() => { work.settled = true; if (flights.get(key) === work) flights.delete(key); });
    flights.set(key,work);
  }
  const work = flight;
  return new Promise<Resolved>((accept,reject) => {
    const detach = () => { options.signal?.removeEventListener("abort",cancel); work.consumers.delete(consumer); if (!work.consumers.size && !work.settled) work.controller.abort(new Error("All lookup consumers cancelled")); };
    const cancel = () => { detach(); reject(options.signal?.reason ?? new Error("Cancelled")); };
    const consumer: Consumer = { options, fail: error => { detach(); reject(error); } };
    work.consumers.add(consumer); options.signal?.addEventListener("abort",cancel,{once:true});
    work.promise.then(result => { if (!work.consumers.has(consumer)) return; detach(); accept(structuredClone(result)); },error => { detach(); reject(error); });
  });
}
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "live";
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = String(seconds % 60).padStart(2,"0");
  return h ? h + ":" + String(m).padStart(2,"0") + ":" + s : m + ":" + s;
}
