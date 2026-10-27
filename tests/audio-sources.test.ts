import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AudioSources } from "../src/media/audio-sources.ts";
import { resolve } from "../src/media/ytdlp.ts";
import { audioSources } from "../src/media/audio-sources.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("playback URLs are reused across seeks, cloned, bounded by expiry and bypass ordinary audio files", async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => now);
  const sources = new AudioSources(async () => {
    calls++;
    return {
      url: "https://cdn.example/audio?expire=" + (now / 1000 + 120),
      headers: { Referer: "https://example.com" },
    };
  });
  const signal = new AbortController().signal;
  const first = await sources.resolve("yt-dlp", "https://youtu.be/abcdefghijk", signal);
  first!.headers.Referer = "mutated";
  assert.equal(
    (await sources.resolve("yt-dlp", "https://www.youtube.com/watch?v=abcdefghijk", signal))!
      .headers.Referer,
    "https://example.com",
  );
  assert.equal(calls, 1);
  now += 61000;
  await sources.resolve("yt-dlp", "https://youtu.be/abcdefghijk", signal);
  assert.equal(calls, 2, "expired signed URLs are refreshed before their safety margin");
  assert.deepEqual(await sources.resolve("yt-dlp", "https://example.com/file.mp3", signal), {
    url: "https://example.com/file.mp3",
    headers: {},
  });
  assert.equal(calls, 2);
});

test("full URL metadata supplies playback audio without a second extractor process or leaking its URL", async (t) => {
  const publicUrl = "https://www.youtube.com/watch?v=reusemeta12";
  let calls = 0;
  const info = {
    title: "Metadata reuse",
    webpage_url: publicUrl,
    requested_formats: [
      { url: "https://cdn.example/video", protocol: "https", vcodec: "avc1", acodec: "none" },
      {
        url: "https://cdn.example/audio?token=private",
        protocol: "https",
        vcodec: "none",
        acodec: "opus",
      },
    ],
    http_headers: { Referer: "https://www.youtube.com" },
  };
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, _args: string[], _options: any, callback: Function) => {
      calls++;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      setImmediate(() => callback(null, "T\t" + JSON.stringify(info) + "\n", ""));
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    const result = await resolve("reuse-metadata", publicUrl, { maxItems: 1 });
    const source = await audioSources.resolve(
      "reuse-metadata",
      publicUrl,
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal(source!.url, info.requested_formats[1]!.url);
    assert.equal(source!.headers.Referer, "https://www.youtube.com");
    assert.doesNotMatch(JSON.stringify(result.tracks), /token=|cdn\.example/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("shared playback extraction survives one cancelled consumer and aborts abandoned lookups", async () => {
  let calls = 0,
    aborted = 0,
    finish!: (value: any) => void;
  const sources = new AudioSources(
    (_path, _url, signal) =>
      new Promise((accept, reject) => {
        calls++;
        finish = accept;
        signal.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const first = new AbortController(),
    second = new AbortController();
  const one = sources.resolve("test", "https://example.com/track", first.signal);
  const two = sources.resolve("test", "https://example.com/track", second.signal);
  await new Promise((resolve) => setImmediate(resolve));
  first.abort(new Error("cancel first"));
  await assert.rejects(one, /cancel first/);
  assert.equal(aborted, 0);
  finish({ url: "https://cdn.example/audio", headers: {} });
  assert.ok(await two);
  assert.equal(calls, 1);
  const last = new AbortController();
  const abandoned = sources.resolve("test", "https://example.com/other", last.signal);
  await new Promise((resolve) => setImmediate(resolve));
  last.abort(new Error("cancel last"));
  await assert.rejects(abandoned, /cancel last/);
  assert.equal(aborted, 1);
});

test("provider headers are sanitized and unsupported protocols retain streamed playback", async (t) => {
  let protocol = "https";
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, _args: string[], _opts: any, callback: Function) => {
      queueMicrotask(() =>
        callback(
          null,
          JSON.stringify({
            url: "https://cdn.example/audio",
            protocol,
            http_headers: {
              "User-Agent": "radiospeak",
              "Bad\r\nHeader": "bad",
              Authorization: "bad\r\nvalue",
            },
          }),
        ),
      );
      return {} as any;
    },
  );
  syncBuiltinESMExports();
  try {
    const sources = new AudioSources(),
      signal = new AbortController().signal;
    const result = await sources.resolve("test", "https://example.com/one", signal);
    assert.deepEqual(result!.headers, { "User-Agent": "radiospeak" });
    protocol = "http_dash_segments";
    assert.equal(await sources.resolve("test", "https://example.com/two", signal), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
