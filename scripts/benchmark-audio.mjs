// Synthetic, isolated workload; never connects a TeamSpeak client or reads bot state.
import { Player } from "../src/audio/player.ts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";

const children = new Set(),
  spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const p = spawn(...args);
  children.add(p);
  p.once("close", () => children.delete(p));
  return p;
};
syncBuiltinESMExports();
const binary = process.env.FFMPEG_PATH || "ffmpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rate = 48000,
  samples = rate * 30,
  audio = Buffer.alloc(44 + samples * 4);
audio.write("RIFF");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(2, 22);
audio.writeUInt32LE(rate, 24);
audio.writeUInt32LE(rate * 4, 28);
audio.writeUInt16LE(4, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36);
audio.writeUInt32LE(samples * 4, 40);
for (let i = 0; i < samples; i++) {
  const n = Math.round(
    3500 * Math.sin((i * 2 * Math.PI * 440) / rate) +
      1500 * Math.sin((i * 2 * Math.PI * 659.25) / rate),
  );
  audio.writeInt16LE(n, 44 + i * 4);
  audio.writeInt16LE(n, 46 + i * 4);
}
const server = createServer((_req, res) =>
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length }).end(audio),
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = "http://127.0.0.1:" + server.address().port + "/tone.wav";
let hz = 100;
if (process.platform === "linux")
  try {
    hz = Number(childProcess.execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  } catch {}
function usage() {
  let ticks = 0,
    rss = 0;
  for (const pid of [process.pid, ...[...children].map((p) => p.pid)])
    try {
      const text = readFileSync("/proc/" + pid + "/stat", "utf8"),
        parts = text.slice(text.lastIndexOf(")") + 2).split(" ");
      ticks += Number(parts[11]) + Number(parts[12]);
      rss +=
        Number(/VmRSS:\s+(\d+)/.exec(readFileSync("/proc/" + pid + "/status", "utf8"))?.[1] || 0) *
        1024;
    } catch {}
  return { ticks, rss };
}
async function run(count, profile, normalization) {
  const frames = Array(count).fill(0),
    errors = [];
  const players = frames.map(
    (_, i) =>
      new Player({
        ffmpegPath: binary,
        ytdlpPath: "unused",
        volume: 50,
        bitrateKbps: 96,
        sendFrame: (p) => {
          if (p.length) frames[i]++;
        },
        log: (level, message) => {
          if (level === "error") errors.push(message);
        },
      }),
  );
  let sampler;
  try {
    players.forEach((p) => {
      p.configure({ audioProfile: profile });
      p.setNormalization(normalization);
      p.playRadio({ name: "Benchmark", url });
    });
    const deadline = Date.now() + 15000;
    while (frames.some((n) => n < 20) && Date.now() < deadline) await sleep(50);
    if (frames.some((n) => n < 20)) throw new Error("Audio did not start: " + errors.join("; "));
    const before = usage(),
      counts = [...frames],
      start = performance.now();
    let peak = before.rss;
    sampler = setInterval(() => {
      peak = Math.max(peak, usage().rss);
    }, 200);
    await sleep(3500);
    const elapsed = (performance.now() - start) / 1000,
      after = usage();
    console.log(
      JSON.stringify({
        bots: count,
        profile,
        normalization,
        cpuPercent: Math.round(((after.ticks - before.ticks) / hz / elapsed) * 1000) / 10,
        peakRssMiB: Math.round(peak / 1048576),
        minimumFps:
          Math.round(Math.min(...frames.map((n, i) => (n - counts[i]) / elapsed)) * 10) / 10,
        underruns: players.reduce((sum, p) => sum + p.health.underruns, 0),
        frameTiming: players.map((p) => p.health.frameTiming),
      }),
    );
  } finally {
    clearInterval(sampler);
    players.forEach((p) => p.stop());
    const until = Date.now() + 3000;
    while (children.size && Date.now() < until) await sleep(25);
    if (children.size) {
      for (const p of children) p.kill("SIGKILL");
      throw new Error("Audio processes did not close");
    }
  }
}
try {
  for (const profile of ["balanced", "high"])
    for (const normalization of [false, true]) await run(1, profile, normalization);
  for (const count of [3, 10]) await run(count, "high", true);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
