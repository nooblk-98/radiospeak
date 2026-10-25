import { execFile } from "node:child_process";

/**
 * Looks up a link (YouTube, SoundCloud, or anything yt-dlp supports) or a
 * search phrase, returning a playable page URL and its title.
 */
export function resolveTrack(ytdlpPath: string, input: string): Promise<{ url: string; title: string }> {
  const target = /^https?:\/\//i.test(input) ? input : `ytsearch1:${input}`;
  return new Promise((resolve, reject) => {
    execFile(
      ytdlpPath,
      ["--no-playlist", "--skip-download", "--no-warnings", "--print", "webpage_url", "--print", "title", target],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new Error("yt-dlp is not installed"));
          const msg = stderr.trim().split(/\r?\n/).pop() || err.message;
          return reject(new Error(msg.replace(/^ERROR:\s*/, "")));
        }
        const [url, title] = stdout.trim().split(/\r?\n/);
        if (!url) return reject(new Error("Nothing found"));
        resolve({ url, title: title || url });
      },
    );
  });
}
