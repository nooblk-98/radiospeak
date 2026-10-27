import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskPool } from "../src/media/task-pool.ts";
import { PlaybackStore } from "../src/persistence/playback-store.ts";
import { Player } from "../src/audio/player.ts";
import { ImportManager } from "../src/library/imports.ts";
import { fixture, tracks } from "./helpers.ts";

const until = async (predicate: () => boolean, limit = 5000) => {
  const deadline = Date.now() + limit;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("lookup pool bounds concurrency and removes cancelled waiters without spending a slot", async () => {
  const pool = new TaskPool(2);
  let running = 0,
    peak = 0;
  const release: Array<() => void> = [];
  const work = () =>
    pool.run(async () => {
      peak = Math.max(peak, ++running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      return "done";
    });
  const one = work(),
    two = work();
  const cancel = new AbortController();
  const cancelled = pool.run(async () => {
    throw new Error("must not run");
  }, cancel.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  cancel.abort(new Error("cancelled"));
  await rejected;
  const three = work();
  await until(() => release.length === 2);
  assert.equal(pool.stats.active, 2);
  assert.equal(pool.stats.queued, 1);
  release.shift()!();
  await one;
  await until(() => release.length === 2);
  release.shift()!();
  release.shift()!();
  await Promise.all([two, three]);
  assert.equal(peak, 2);
  assert.equal(pool.stats.active, 0);
});

test("asynchronous checkpoint bursts coalesce and flush the newest state for every bot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "radiospeak-async-"));
  try {
    const path = join(dir, "playback.json"),
      store = new PlaybackStore(path);
    const player = new Player({
      ffmpegPath: "unused",
      ytdlpPath: "unused",
      bitrateKbps: 96,
      volume: 50,
      connectionPaused: true,
      log() {},
      sendFrame() {},
    });
    player.enqueue(tracks);
    player.seek(12);
    for (let i = 0; i < 100; i++) {
      player.setVolume(i);
      store.set("one", player.snapshot());
    }
    const pending = store.flush();
    player.seek(88);
    store.set("two", player.snapshot());
    player.setVolume(42);
    store.set("one", player.snapshot());
    await pending;
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data.bots.one.volume, 42);
    assert.equal(data.bots.two.elapsed, 88);
    assert.equal(store.status.pending, false);
    assert.equal(store.status.error, false);
    assert.ok(store.lastSavedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background imports report progress, detect alternate-link duplicates, retain partial failures and cancel safely", async () => {
  const f = await fixture();
  try {
    const list = f.app.playlists.create("Imported");
    f.app.playlists.addTracks(list, [tracks[0]!]);
    const manager = new ImportManager(
      f.app.playlists,
      "unused",
      300,
      async (_path, _input, options) => {
        options.onProgress?.({ processed: 3, total: 4, title: "Last entry" });
        return {
          tracks: [{ ...tracks[0]!, url: "https://youtu.be/abcdefghijk" }, tracks[1]!, tracks[1]!],
          skipped: ["Private video"],
        };
      },
    );
    const job = manager.start(list.id, "public URL");
    await until(() => job.status === "completed");
    assert.equal(job.added, 1);
    assert.equal(job.duplicates, 2);
    assert.equal(job.failed, 1);
    assert.equal(list.tracks.length, 2);
    assert.deepEqual(job.errors, ["Private video"]);
    const cancelManager = new ImportManager(
      f.app.playlists,
      "unused",
      300,
      async (_path, _input, options) => {
        await new Promise<void>((_accept, reject) =>
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          }),
        );
        return { tracks };
      },
    );
    const cancelled = cancelManager.start(list.id, "another link");
    cancelManager.cancel(cancelled.id);
    await until(() => cancelled.status === "cancelled");
    assert.equal(list.tracks.length, 2);
  } finally {
    await f.close();
  }
});

test("HTTP state contains library summaries; paged edits retain global positions and stale versions are rejected", async () => {
  const f = await fixture();
  try {
    const list = f.app.playlists.create("Large");
    const many = Array.from({ length: 125 }, (_, i) => ({
      url: "https://example.com/" + i,
      title: "Track " + i,
      duration: 30,
    }));
    f.app.playlists.addTracks(list, many);
    const summary = (await f.api("/api/state")).data.playlists[0];
    assert.equal(summary.trackCount, 125);
    assert.equal(summary.tracks, undefined);
    assert.equal(summary.totalDuration, 3750);
    const page = (await f.api("/api/playlists/" + list.id + "?offset=50&limit=50")).data;
    assert.equal(page.tracks.length, 50);
    assert.equal(page.tracks[0].title, "Track 50");
    assert.equal(
      (
        await f.api("/api/playlists/" + list.id + "/move", {
          from: 51,
          to: 1,
          expectedVersion: page.version,
        })
      ).status,
      200,
    );
    assert.equal(list.tracks[0]?.title, "Track 50");
    assert.equal(
      (
        await f.api(
          "/api/playlists/" + list.id + "/tracks/51",
          { expectedVersion: page.version },
          "DELETE",
        )
      ).status,
      409,
    );
    const health = (await f.api("/api/state")).data;
    assert.ok(health.system.memoryMB > 0);
    assert.equal(typeof health.bots[0].health.underruns, "number");
    assert.equal((await f.api("/api/bots/Test%20bot/prebuffer", { enabled: true })).status, 200);
    assert.equal(f.app.bots[0]!.health.prebufferEnabled, true);
  } finally {
    await f.close();
  }
});

test("queue removals are undoable once; later queue edits invalidate undo", async () => {
  const f = await fixture(),
    path = "/api/bots/Test%20bot/";
  try {
    const original = f.app.bots[0]!.player.queue.map((t) => t.url);
    const removed = await f.api(path + "remove", { position: 2, expected: original });
    assert.ok(removed.data.undoToken);
    assert.equal((await f.api(path + "undo", { token: removed.data.undoToken })).status, 200);
    assert.deepEqual(
      f.app.bots[0]!.player.queue.map((t) => t.url),
      original,
    );
    assert.equal((await f.api(path + "undo", { token: removed.data.undoToken })).status, 409);
    const next = await f.api(path + "remove", { position: 1 });
    await f.api(path + "enqueue", { tracks: [tracks[0]] });
    assert.equal((await f.api(path + "undo", { token: next.data.undoToken })).status, 409);
  } finally {
    await f.close();
  }
});

test("authenticated SSE sends complete state and lightweight progress without repeating playlist tracks", async () => {
  const f = await fixture("password"),
    controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assert.equal((await fetch(f.base + "/api/events")).status, 401);
    const response = await fetch(f.base + "/api/events", {
      signal: controller.signal,
      headers: { Authorization: "Basic " + Buffer.from("x:password").toString("base64") },
    });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    reader = response.body!.getReader();
    let buffer = "";
    const deadline = Date.now() + 5000;
    while (!buffer.includes("event: playback_progress")) {
      if (Date.now() > deadline) throw new Error("No SSE progress received");
      const part = await reader.read();
      if (part.done) break;
      buffer += new TextDecoder().decode(part.value);
    }
    assert.match(buffer, /event: state/);
    assert.match(buffer, /event: playback_progress/);
    const frames = buffer.split("\n\n").filter((s) => s.includes("event: playback_progress"));
    const data = JSON.parse(frames[0]!.split("data: ")[1]!);
    assert.equal(data.playlists, undefined);
    assert.equal(data.bots[0].queue, undefined);
    assert.equal(data.bots[0].name, "Test bot");
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await f.close();
  }
});
