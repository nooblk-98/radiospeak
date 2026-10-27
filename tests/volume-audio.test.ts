import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import childProcess, { execFileSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Player } from "../src/audio/player.ts";
import { settingsFrom } from "../src/domain/policies.ts";
import { AudioSources } from "../src/media/audio-sources.ts";

function wave() {
  const samples = 48000 * 20,
    buffer = Buffer.alloc(44 + samples * 4);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(192000, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / 48000));
    buffer.writeInt16LE(value, 44 + i * 4);
    buffer.writeInt16LE(value, 46 + i * 4);
  }
  return buffer;
}
function page(packet: Buffer, sequence: number, granule: number, flags = 0) {
  const segments = Math.floor(packet.length / 255) + 1,
    buffer = Buffer.alloc(27 + segments + packet.length);
  buffer.write("OggS");
  buffer[5] = flags;
  buffer.writeBigUInt64LE(BigInt(granule), 6);
  buffer.writeUInt32LE(1, 14);
  buffer.writeUInt32LE(sequence, 18);
  buffer[26] = segments;
  for (let i = 0; i < segments; i++) buffer[27 + i] = Math.min(255, packet.length - i * 255);
  packet.copy(buffer, 27 + segments);
  let crc = 0;
  for (const byte of buffer) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  buffer.writeUInt32LE(crc, 22);
  return buffer;
}
function ogg(packets: Buffer[]) {
  const head = Buffer.alloc(19);
  head.write("OpusHead");
  head[8] = 1;
  head[9] = 2;
  head.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16);
  tags.write("OpusTags");
  return Buffer.concat([
    page(head, 0, 0, 2),
    page(tags, 1, 0),
    ...packets.map((packet, i) =>
      page(packet, i + 2, (i + 1) * 960, i === packets.length - 1 ? 4 : 0),
    ),
  ]);
}
function rms(pcm: Buffer, startFrame: number, endFrame: number) {
  let sum = 0,
    count = 0;
  for (
    let offset = startFrame * 3840;
    offset < Math.min(pcm.length, endFrame * 3840);
    offset += 2
  ) {
    const n = pcm.readInt16LE(offset);
    sum += n * n;
    count++;
  }
  return Math.sqrt(sum / count);
}
for (const profile of ["high", "balanced"] as const)
  for (const normalization of [false, true])
    test(
      "real Opus output follows live volume changes: " +
        profile +
        (normalization ? " with normalization" : ""),
      { skip: !process.env.FFMPEG_PATH, timeout: 20000 },
      async (t) => {
        const running = new Set<ChildProcess>(),
          spawn = childProcess.spawn;
        t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          running.add(child);
          child.once("close", () => running.delete(child));
          return child;
        });
        syncBuiltinESMExports();
        const binary = process.env.FFMPEG_PATH!,
          audio = wave();
        const server = createServer((_req, res) =>
          res
            .writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length })
            .end(audio),
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const packets: Buffer[] = [],
          errors: string[] = [];
        let finish: () => void;
        const done = new Promise<void>((accept) => {
          finish = accept;
        });
        const player = new Player({
          ffmpegPath: binary,
          ytdlpPath: "unused",
          bitrateKbps: 96,
          volume: 100,
          log(level, message) {
            if (level === "warn" || level === "error") errors.push(message);
          },
          sendFrame(frame) {
            if (!frame.length) return;
            packets.push(Buffer.from(frame));
            if (packets.length === 40) player.setVolume(25);
            if (packets.length === 110) player.setVolume(100);
            if (packets.length === 170) finish!();
          },
        });
        let timer: ReturnType<typeof setTimeout>;
        try {
          player.setNormalization(normalization);
          player.configure(settingsFrom({ audioProfile: profile }));
          player.playRadio({
            name: "Test tone",
            url: "http://127.0.0.1:" + address.port + "/tone.wav",
          });
          await Promise.race([
            done,
            new Promise((_accept, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Audio timeout: " + JSON.stringify(player.health) + " " + errors.join(";"),
                    ),
                  ),
                15000,
              );
            }),
          ]);
          assert.ok(
            player.health.level.sourceDb > -40 && player.health.level.sourceDb < 0,
            "meter sees decoded source amplitude",
          );
          assert.ok(player.health.frameTiming.samples >= 170, "frame deadlines are measured");
          player.stop();
          const decoded = execFileSync(
            binary,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "ogg",
              "-i",
              "pipe:0",
              "-f",
              "s16le",
              "-ac",
              "2",
              "-ar",
              "48000",
              "pipe:1",
            ],
            { input: ogg(packets), maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          );
          const loud = rms(decoded, 10, 30),
            quiet = rms(decoded, 55, 70),
            restored = rms(decoded, 150, 165);
          assert.ok(loud > 500);
          assert.ok(
            quiet / loud > 0.18 && quiet / loud < 0.33,
            "25% volume must reach the decoded output within 300 ms: " + quiet / loud,
          );

          assert.ok(
            restored / loud > 0.85 && restored / loud < 1.15,
            "unmuted volume must return to its original amplitude",
          );
        } finally {
          clearTimeout(timer!);
          player.stop();
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
          try {
            const deadline = Date.now() + 2000;
            while (running.size && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 20));
            assert.equal(
              running.size,
              0,
              "stopping playback must close every FFmpeg process, including blocked decoders",
            );
          } finally {
            for (const child of running) child.kill("SIGKILL");
            t.mock.restoreAll();
            syncBuiltinESMExports();
          }
        }
      },
    );

test(
  "real silent radio generates one sustained-silence alert and mute suppresses it",
  { skip: !process.env.FFMPEG_PATH, timeout: 20000 },
  async () => {
    const audio = wave();
    audio.fill(0, 44);
    const server = createServer((_req, res) =>
      res
        .writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length })
        .end(audio),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let warnings = 0;
    const player = new Player({
      ffmpegPath: process.env.FFMPEG_PATH!,
      ytdlpPath: "unused",
      bitrateKbps: 96,
      volume: 0,
      sendFrame() {},
      log(level, message) {
        if (level === "warn" && message.includes("below")) warnings++;
      },
    });
    const wait = async (predicate: () => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > until)
          throw new Error("Silent audio timeout: " + JSON.stringify(player.health));
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    try {
      player.configure(
        settingsFrom({
          silence: { enabled: true, thresholdDb: -55, seconds: 5, radioFailover: false },
        }),
      );
      player.playRadio({ name: "Silence", url: "http://127.0.0.1:" + address.port });
      await wait(() => player.health.frameTiming.samples > 100, 5000);
      assert.equal(player.health.silenceSeconds, 0);
      assert.equal(warnings, 0);
      player.setVolume(60);
      await wait(() => warnings === 1, 8000);
      assert.match(player.health.silenceAlert!.message, /below -55 dB/);
      assert.ok(player.health.level.sourceDb < -95);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(warnings, 1, "continuous silence does not flood notifications");
    } finally {
      player.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  "real FFmpeg seeks through HTTP ranges without downloading and decoding the entire prefix",
  { skip: !process.env.FFMPEG_PATH, timeout: 15000 },
  async (t) => {
    // A 60 second file over a throttled connection makes decoding a 45 second prefix visibly slow.
    const tone = wave();
    const audio = Buffer.concat([
      tone.subarray(0, 44),
      tone.subarray(44),
      tone.subarray(44),
      tone.subarray(44),
    ]);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.writeUInt32LE(audio.length - 44, 40);
    const ranges: number[] = [];
    const server = createServer((req, res) => {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
      ranges.push(start);
      res.writeHead(req.headers.range ? 206 : 200, {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Length": audio.length - start,
        ...(req.headers.range
          ? { "Content-Range": `bytes ${start}-${audio.length - 1}/${audio.length}` }
          : {}),
      });
      let offset = start;
      const timer = setInterval(() => {
        const next = Math.min(offset + 16384, audio.length);
        if (!res.writableNeedDrain) {
          res.write(audio.subarray(offset, next));
          offset = next;
        }
        if (offset === audio.length) {
          clearInterval(timer);
          res.end();
        }
      }, 10);
      res.on("close", () => clearInterval(timer));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    let lookups = 0,
      frames = 0;
    const sources = new AudioSources(async () => {
      lookups++;
      return { url: `http://127.0.0.1:${address.port}/tone.wav`, headers: {} };
    });
    const player = new Player({
      ffmpegPath: process.env.FFMPEG_PATH!,
      ytdlpPath: "unused",
      bitrateKbps: 96,
      volume: 50,
      resolveSource: (url, signal) => sources.resolve("test", url, signal),
      log() {},
      sendFrame: (frame) => {
        if (frame.length) frames++;
      },
    });
    const wait = async (ready: () => boolean, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (!ready()) {
        if (Date.now() > deadline)
          throw new Error("Seek timeout: " + JSON.stringify(player.health));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      player.enqueue([{ url: "https://example.com/song", title: "Seek test", duration: 60 }]);
      await wait(() => frames >= 10);
      const before = frames,
        started = performance.now();
      player.seek(45);
      await wait(() => frames > before, 1800);
      const latency = performance.now() - started;
      assert.ok(
        ranges.some((start) => start >= 45 * 192000),
        "FFmpeg uses a range close to the requested time",
      );
      assert.equal(lookups, 1, "seeking reuses the resolved source");
      assert.ok(player.elapsed >= 45 && player.elapsed < 46);
      assert.ok(player.health.startupMs !== null);
      t.diagnostic(`Seek to 45s: ${Math.round(latency)} ms to first audio packet`);
    } finally {
      player.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
