import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolve, mediaStats } from "../src/media/ytdlp.ts";
import { tracks } from "./helpers.ts";

test("search cache reuses metadata, clones cached results, and separates source/query keys", async (t) => {
  let calls = 0;
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, _args: string[], _options: any, callback: Function) => {
      calls++;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      setImmediate(() => {
        const output = "T\t" + JSON.stringify({ ...tracks[0], webpage_url: tracks[0]!.url }) + "\n";
        child.stdout.write(output);
        callback(null, output, "");
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    const one = await resolve("fake", "cache this query", {
      maxItems: 10,
      results: 10,
      source: "youtube",
    });
    one.tracks[0]!.title = "mutated";
    const two = await resolve("fake", "cache this query", {
      maxItems: 10,
      results: 10,
      source: "youtube",
    });
    assert.equal(calls, 1);
    assert.equal(two.tracks[0]!.title, tracks[0]!.title);
    await resolve("fake", "cache this query", { maxItems: 10, results: 10, source: "soundcloud" });
    assert.equal(calls, 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
test("identical pending lookups share one child and an individual cancellation keeps the other consumer alive", async (t) => {
  let calls = 0,
    finish: Function,
    childSignal: AbortSignal;
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, _args: string[], options: any, callback: Function) => {
      calls++;
      finish = callback;
      childSignal = options.signal;
      return Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    },
  );
  syncBuiltinESMExports();
  try {
    const controller = new AbortController();
    const one = resolve("shared-fake", "same work", {
      maxItems: 10,
      results: 10,
      signal: controller.signal,
    });
    const cancelled = assert.rejects(one, /cancel/);
    const two = resolve("shared-fake", "same work", { maxItems: 10, results: 10 });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    controller.abort(new Error("cancel this consumer"));
    await cancelled;
    assert.equal(childSignal!.aborted, false);
    finish!(null, "T\t" + JSON.stringify({ ...tracks[0], webpage_url: tracks[0]!.url }) + "\n", "");
    assert.equal((await two).tracks[0]?.title, tracks[0]!.title);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
test("abandoned searches abort active children and queued lookups never launch", async (t) => {
  let calls = 0,
    aborts = 0;
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, _args: string[], options: any, callback: Function) => {
      calls++;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      options.signal.addEventListener(
        "abort",
        () => {
          aborts++;
          callback(new Error("aborted"), "", "");
        },
        { once: true },
      );
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const pending = controllers.map((controller, index) =>
      resolve("fake", "cancel " + index, { maxItems: 10, results: 10, signal: controller.signal }),
    );
    const settled = Promise.allSettled(pending);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    assert.equal(mediaStats().queued, 1);
    controllers[2]!.abort(new Error("queued cancelled"));
    controllers[0]!.abort(new Error("active cancelled"));
    controllers[1]!.abort(new Error("active cancelled"));
    assert.ok((await settled).every((result) => result.status === "rejected"));
    assert.equal(calls, 2);
    assert.equal(aborts, 2);
    assert.equal(mediaStats().active, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
test("partial imports stream actual progress and retain readable errors for unavailable entries", async (t) => {
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, args: string[], _options: any, callback: Function) => {
      assert.ok(args.includes("--ignore-errors"));
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      setImmediate(() => {
        const line =
          "T\t" +
          JSON.stringify({ ...tracks[0], webpage_url: tracks[0]!.url, playlist_count: 3 }) +
          "\n";
        child.stdout.write(line.slice(0, 15));
        child.stdout.write(line.slice(15));
        callback(new Error("partial"), line, "ERROR: Private video\n");
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    const progress: any[] = [];
    const result = await resolve("fake", "https://example.com/list", {
      maxItems: 100,
      partial: true,
      onProgress: (update) => progress.push(update),
    });
    assert.equal(result.tracks.length, 1);
    assert.equal(progress[0].processed, 1);
    assert.equal(progress[0].total, 3);
    assert.match(result.skipped![0]!, /Private video/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("search pages through results and finds YouTube playlists", async (t) => {
  const calls: string[][] = [];
  t.mock.method(
    childProcess,
    "execFile",
    (_path: string, args: string[], _options: any, callback: Function) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      const target = args.at(-1)!;
      const entries = target.startsWith("https://www.youtube.com/results")
        ? target.includes("nothing+here")
          ? []
          : [
              {
                url: "https://www.youtube.com/playlist?list=PLfirst000000",
                title: "Sinhala hits",
                uploader: "Hits channel",
              },
              {
                url: "https://www.youtube.com/watch?v=abcdefghijk&list=PLmixed",
                title: "A video inside a list",
              },
              { url: "https://www.youtube.com/@somechannel", title: "A channel" },
              { url: "https://www.youtube.com/playlist?list=PLsecond00000", title: "Chill mix" },
            ]
        : Array.from({ length: 10 }, (_, i) => ({
            webpage_url:
              "https://www.youtube.com/watch?v=page" +
              args[args.indexOf("--playlist-start") + 1] +
              "x" +
              i,
            title: "Song " + i,
          }));
      setImmediate(() => {
        const output = entries.map((e) => "T\t" + JSON.stringify(e)).join("\n") + "\n";
        child.stdout.write(output);
        callback(null, output, "");
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  const { fixture } = await import("./helpers.ts");
  const f = await fixture();
  try {
    const second = await f.api("/api/search?q=paging+query&page=2");
    assert.equal(second.status, 200);
    assert.equal(second.data.length, 10);
    const args = calls.at(-1)!;
    assert.equal(args.at(-1), "ytsearch20:paging query", "page 2 asks for the top 20");
    assert.deepEqual(
      [args[args.indexOf("--playlist-start") + 1], args[args.indexOf("--playlist-end") + 1]],
      ["11", "20"],
      "and keeps only results 11–20",
    );
    const lists = await f.api("/api/search?q=sinhala+songs&type=playlists");
    assert.equal(lists.status, 200);
    assert.deepEqual(
      lists.data.map((p: { title: string }) => p.title),
      ["Sinhala hits", "Chill mix"],
      "only real playlists are returned",
    );
    const url = new URL(calls.at(-1)!.at(-1)!);
    assert.equal(url.searchParams.get("search_query"), "sinhala songs");
    assert.equal(url.searchParams.get("sp"), "EgIQAw==", "YouTube's playlist filter");
    assert.deepEqual(
      (await f.api("/api/search?q=nothing+here&type=playlists")).data,
      [],
      "no playlists is an empty list, not an error",
    );
    assert.equal((await f.api("/api/search?q=x&type=playlists&source=soundcloud")).status, 400);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});
