// Runs the audio pipeline without TeamSpeak and reports pacing.
// Usage: node src/audio/test-audio.ts <link, search words or radio:<url>> [seconds]
// Set TEST_OUT=file.ogg to also save what the bot would send, to listen to it.
import { createWriteStream } from "node:fs";
import { resolve } from "../media/ytdlp.ts";
import { audioSources } from "../media/audio-sources.ts";
import { Player } from "./player.ts";

const [input = "never gonna give you up", secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 15);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ytdlpPath = process.env.YTDLP_PATH ?? "yt-dlp";

let frames = 0;
let bytes = 0;
let first = 0;
const out = process.env.TEST_OUT
  ? createWriteStream(`${process.env.TEST_OUT}.opus-frames`)
  : undefined;
const player = new Player({
  ffmpegPath,
  ytdlpPath,
  resolveSource: (url, signal) => audioSources.resolve(ytdlpPath, url, signal),
  invalidateSource: (url) => audioSources.invalidate(ytdlpPath, url),
  bitrateKbps: 96,
  volume: 50,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
  onEvent: (e) =>
    e.type !== "change" &&
    console.log(`[event] ${e.type}`, e.track.title, "error" in e ? e.error : ""),
  sendFrame(frame) {
    if (frame.length === 0) return;
    if (!first) first = performance.now();
    frames++;
    bytes += frame.length;
    // Length-prefixed raw Opus frames, for scripts/frames-to-wav or inspection.
    if (out) {
      const len = Buffer.alloc(2);
      len.writeUInt16LE(frame.length);
      out.write(len);
      out.write(frame);
    }
  },
});

if (input.startsWith("radio:")) {
  player.playRadio({ name: "test", url: input.slice(6) });
} else {
  const found = await resolve(ytdlpPath, input, { maxItems: 5 });
  console.log(`Resolved: ${found.playlist ?? ""} ${found.tracks.map((t) => t.title).join(" | ")}`);
  player.enqueue(found.tracks);
}

// Exercise volume and pause/resume along the way.
setTimeout(() => player.setVolume(80), (seconds * 1000) / 3);
setTimeout(() => player.pause(), (seconds * 1000) / 2);
setTimeout(() => player.resume(), (seconds * 1000) / 2 + 2000);
setTimeout(() => {
  const elapsed = (performance.now() - first) / 1000 - 2; // minus the pause
  console.log(
    `frames=${frames} over ~${elapsed.toFixed(1)}s => ${(frames / elapsed).toFixed(1)} fps (expect 50), ` +
      `avg ${(bytes / Math.max(frames, 1)).toFixed(0)} B/frame, underruns=${player.underruns}, song position ${player.elapsed}s`,
  );
  player.stop();
  out?.end();
  process.exit(frames > 0 ? 0 : 1);
}, seconds * 1000);
