import { execFile } from "node:child_process";
import type { Track } from "./player.ts";
import { TaskPool } from "./task-pool.ts";

export interface Resolved {
  tracks: Track[];
  playlist?: string;
  skipped?: string[];
}
export interface ResolveOptions {
  maxItems: number;
  results?: number;
  wholePlaylist?: boolean;
  source?: "youtube" | "soundcloud";
  signal?: AbortSignal;
  partial?: boolean;
  onProgress?: (progress: { processed: number; total: number | null; title: string }) => void;
}
const pool = new TaskPool(2);
const cache = new Map<string, { until: number; result: Resolved }>();
export const mediaStats = () => ({ ...pool.stats, cachedSearches: cache.size });
const isUrl = (s: string) => /^https?:\/\//i.test(s);
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
    if (options.onProgress) child.stdout?.on("data", (chunk: Buffer | string) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("T\t")) continue;
        try {
          const entry = JSON.parse(line.slice(2));
          processed++;
          const total = Number(entry.playlist_count ?? entry.n_entries);
          options.onProgress?.({ processed, total: total > 0 ? Math.min(total, options.maxItems) : null, title: String(entry.title ?? "") });
        } catch { /* incomplete or unavailable entry */ }
      }
    });
  });
}
export function playlistId(url: string): string | undefined {
  try { return new URL(url).searchParams.get("list") ?? undefined; } catch { return undefined; }
}
export async function resolve(path: string, input: string, options: ResolveOptions): Promise<Resolved> {
  let text = input.trim();
  if (!text) throw new Error("Nothing to look up");
  options.signal?.throwIfAborted();
  const url = isUrl(text), list = url ? playlistId(text) : undefined;
  const key = JSON.stringify([path,text.toLowerCase(),options.source,options.results,options.maxItems]);
  const cached = !url && (options.results ?? 1) > 1 ? cache.get(key) : undefined;
  if (cached && cached.until > Date.now()) return structuredClone(cached.result);
  if (options.wholePlaylist && list) text = "https://www.youtube.com/playlist?list=" + list;
  const target = url ? text : (options.source === "soundcloud" ? "scsearch" : "ytsearch") + (options.results ?? 1) + ":" + text;
  const args = [
    "--flat-playlist", "--skip-download", "--no-warnings", "--newline", "--encoding", "utf-8",
    "--playlist-end", String(options.maxItems), "--print", "T\t%()j", "--print", "playlist:P\t%(title|)s",
    ...(options.partial ? ["--ignore-errors"] : []),
    ...(url && isSingleVideo(text) ? ["--no-playlist"] : []), "--", target,
  ];
  const { stdout, stderr } = await pool.run(() => run(path,args,options),options.signal);
  const tracks: Track[] = [], skipped: string[] = [];
  let playlist: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("P\t")) { playlist = line.slice(2).trim() || undefined; continue; }
    if (!line.startsWith("T\t")) continue;
    try {
      const entry = JSON.parse(line.slice(2));
      const title = String(entry.title ?? "").trim(), link = entry.webpage_url || entry.url;
      if (!link || !isUrl(link) || /^\[(private|deleted) video\]$/i.test(title)) {
        skipped.push(title || "Unavailable entry"); continue;
      }
      const seconds = Number(entry.duration), thumbnail = entry.thumbnail ?? entry.thumbnails?.at(-1)?.url;
      const artist = entry.artist || entry.uploader || entry.channel;
      tracks.push({ url: link, title: title || link,
        ...(Number.isFinite(seconds) && seconds > 0 ? { duration: Math.round(seconds) } : {}),
        ...(artist ? { artist: String(artist) } : {}), ...(thumbnail ? { thumbnail: String(thumbnail) } : {}) });
    } catch { skipped.push("Invalid media entry"); }
  }
  for (const error of stderr.split(/\r?\n/).filter(s=>s.startsWith("ERROR:"))) {
    if (!skipped.includes(error)) skipped.push(error.slice(7).slice(0,300));
  }
  if (!tracks.length) throw new Error(skipped[0] || (url ? "Nothing playable at that link" : 'Nothing found for "' + text + '"'));
  const result: Resolved = { tracks, ...(url && tracks.length > 1 && playlist ? { playlist } : {}), ...(skipped.length ? { skipped } : {}) };
  if (!url && (options.results ?? 1) > 1) {
    for (const [id, value] of cache) if (value.until <= Date.now()) cache.delete(id);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + 60_000, result: structuredClone(result) });
  }
  return result;
}
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "live";
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = String(seconds % 60).padStart(2,"0");
  return h ? h + ":" + String(m).padStart(2,"0") + ":" + s : m + ":" + s;
}
