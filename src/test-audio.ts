// Runs the radio pipeline without TeamSpeak and reports frame pacing.
// Usage: node src/test-audio.ts [station-id] [seconds]
import { loadStations } from "./config.ts";
import { RadioPlayer } from "./radio.ts";

const [query, secondsArg] = process.argv.slice(2);
const stations = loadStations();
const station = (query && stations.find((s) => s.id === query)) || stations[0];
if (!station) throw new Error("No stations in stations.json");
const seconds = Number(secondsArg ?? 10);

let frames = 0;
let bytes = 0;
let first = 0;
const radio = new RadioPlayer({
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  bitrateKbps: 96,
  volume: 50,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
  sendFrame(frame) {
    if (frame.length === 0) return console.log("(end of speech)");
    if (!first) first = performance.now();
    frames++;
    bytes += frame.length;
  },
});

radio.play(station);
setTimeout(() => {
  radio.stop();
  const elapsed = (performance.now() - first) / 1000;
  console.log(
    `frames=${frames} over ${elapsed.toFixed(2)}s => ${(frames / elapsed).toFixed(1)} fps (expect 50), ` +
      `avg ${(bytes / Math.max(frames, 1)).toFixed(0)} B/frame, ${((bytes * 8) / elapsed / 1000).toFixed(0)} kbps`,
  );
  process.exit(frames > 0 ? 0 : 1);
}, seconds * 1000);
