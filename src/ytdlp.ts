import { execFile } from "node:child_process";
import type { Track } from "./player.ts";

export interface Resolved {
  tracks: Track[];
  /** Set when a playlist link was given. */
  playlist?: string;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** A link to one video that also carries a playlist (watch?v=...&list=...) means that one song. */
function isSingleVideo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "youtu.be" || u.searchParams.has("v");
  } catch {
    return false;
  }
}

function run(ytdlpPath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ytdlpPath,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("yt-dlp is not installed"));
          if (err.killed) return reject(new Error("YouTube took too long to answer"));
          const msg = stderr.trim().split(/\r?\n/).pop() || err.message;
          return reject(new Error(msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "")));
        }
        resolve(stdout);
      },
    );
  });
}

/** The playlist ID in a YouTube link, if it has one. */
export function playlistId(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("list") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks up a link (a song or a whole playlist, on YouTube, SoundCloud or any
 * site yt-dlp supports) or search words, without downloading anything.
 * `results` > 1 returns that many search matches instead of the best one.
 * `wholePlaylist` turns a song-inside-a-playlist link into the whole playlist.
 */
export async function resolve(
  ytdlpPath: string,
  input: string,
  options: { maxItems: number; results?: number; wholePlaylist?: boolean },
): Promise<Resolved> {
  let text = input.trim();
  if (!text) throw new Error("Nothing to look up");
  const url = isUrl(text);
  const list = url ? playlistId(text) : undefined;
  if (options.wholePlaylist && list) text = `https://www.youtube.com/playlist?list=${list}`;
  const target = url ? text : `ytsearch${options.results ?? 1}:${text}`;
  const args = [
    "--flat-playlist",
    // Needed: a "playlist:" --print would otherwise turn simulation off and download the video.
    "--skip-download",
    "--no-warnings",
    "--encoding", "utf-8",
    "--playlist-end", String(options.maxItems),
    "--print", "T\t%(webpage_url|)s\t%(url|)s\t%(duration|)s\t%(title|)s",
    "--print", "playlist:P\t%(title|)s",
    ...(url && isSingleVideo(text) ? ["--no-playlist"] : []),
    target,
  ];
  const out = await run(ytdlpPath, args, 90_000);

  const tracks: Track[] = [];
  let playlist: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    const [kind, ...f] = line.split("\t");
    if (kind === "P") playlist = f.join("\t").trim() || undefined;
    if (kind !== "T") continue;
    const [pageUrl = "", mediaUrl = "", duration = "", ...titleParts] = f;
    const title = titleParts.join("\t").trim();
    const link = pageUrl || mediaUrl;
    if (!link || /^\[(private|deleted) video\]$/i.test(title)) continue;
    const seconds = Number(duration);
    tracks.push({ url: link, title: title || link, ...(seconds > 0 ? { duration: Math.round(seconds) } : {}) });
  }
  if (tracks.length === 0) throw new Error(url ? "Nothing playable at that link" : `Nothing found for "${text}"`);
  // A search reports its query as the "playlist"; only real playlists keep a name.
  return url && tracks.length > 1 && playlist ? { tracks, playlist } : { tracks };
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "live";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
