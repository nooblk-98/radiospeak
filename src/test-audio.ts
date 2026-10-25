// Runs the audio pipeline without TeamSpeak and reports frame pacing.
// Usage: node src/test-audio.ts [station-id | yt:<link or search>] [seconds]
import { RadioPlayer } from "./radio.ts";
import { StationStore } from "./store.ts";
import { resolveTrack } from "./ytdlp.ts";

const [query = "", secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 10);
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ytdlpPath = process.env.YTDLP_PATH ?? "yt-dlp";

let frames = 0;
let bytes = 0;
let first = 0;
const radio = new RadioPlayer({
  ffmpegPath,
  ytdlpPath,
  bitrateKbps: 96,
  volume: 50,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
  onEvent: (e) => e.type !== "change" && console.log(`[event] ${e.type}`, "track" in e ? e.track.title : ""),
  sendFrame(frame) {
    if (frame.length === 0) return console.log("(end of speech)");
    if (!first) first = performance.now();
    frames++;
    bytes += frame.length;
  },
});

if (query.startsWith("yt:")) {
  const track = await resolveTrack(ytdlpPath, query.slice(3));
  console.log(`Resolved: ${track.title} (${track.url})`);
  radio.enqueue(track);
} else {
  const stations = new StationStore();
  const station = stations.find(query) ?? stations.items[0];
  if (!station) throw new Error("No stations in stations.json");
  radio.play(station);
}

// Exercise the instant volume path halfway through.
setTimeout(() => radio.setVolume(80), (seconds * 1000) / 2);
setTimeout(() => {
  radio.stop();
  const elapsed = (performance.now() - first) / 1000;
  console.log(
    `frames=${frames} over ${elapsed.toFixed(2)}s => ${(frames / elapsed).toFixed(1)} fps (expect 50), ` +
      `avg ${(bytes / Math.max(frames, 1)).toFixed(0)} B/frame, ${((bytes * 8) / elapsed / 1000).toFixed(0)} kbps`,
  );
  process.exit(frames > 0 ? 0 : 1);
}, seconds * 1000);
