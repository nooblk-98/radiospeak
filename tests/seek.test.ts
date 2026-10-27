import assert from "node:assert/strict";
import test from "node:test";
import { SeekControl } from "../src/web/features/seek.js";
import { fixture } from "./helpers.ts";

test("rapid seeks keep the newest chosen position and serialize track-specific requests", async () => {
  const calls: any[] = [],
    pending: Array<() => void> = [];
  const control = new SeekControl({
    send: (name: string, url: string, seconds: number) => {
      calls.push([name, url, seconds]);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
  });
  assert.equal(control.get("idle-bot", undefined), undefined);
  control.set("one", "track-a", 20);
  control.set("one", "track-a", 50);
  control.set("one", "track-a", 75);
  assert.equal(control.get("one", "track-a"), 75);
  assert.equal(calls.length, 1);
  assert.equal(control.get("one", "track-b"), undefined);
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ["one", "track-a", 20],
    ["one", "track-a", 75],
  ]);
  pending.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.get("one", "track-a"), undefined);
});

test("control responses acknowledge position and volume with revisioned lightweight playback state", async () => {
  const f = await fixture();
  try {
    const bot = f.app.bots[0]!;
    const volume = await f.api("/api/bots/Test%20bot/volume", { volume: 25 });
    assert.equal(volume.status, 200);
    assert.equal(volume.data.playback.volume, 25);
    assert.equal(volume.data.playback.generation, bot.generation);
    const seek = await f.api("/api/bots/Test%20bot/seek", {
      url: bot.player.track!.url,
      seconds: 80.5,
    });
    assert.equal(seek.status, 200);
    assert.equal(seek.data.playback.elapsed, 80.5);
    assert.ok(seek.data.playback.revision > volume.data.playback.revision);
    assert.equal(seek.data.playback.queue, undefined);
    assert.equal(seek.data.playback.playlists, undefined);
    assert.equal(
      (await f.api("/api/bots/Test%20bot/seek", { url: "old-track", seconds: 20 })).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("a drag preview survives earlier seek acknowledgements and sends nothing until committed", async () => {
  const calls: number[] = [],
    releases: Array<() => void> = [];
  const control = new SeekControl({
    send: (_name: string, _url: string, seconds: number) => {
      calls.push(seconds);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  control.set("one", "track", 10);
  control.preview("one", "track", 70);
  assert.deepEqual(calls, [10]);
  assert.equal(control.get("one", "track"), 70);
  releases.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    control.get("one", "track"),
    70,
    "an earlier response must not replace the new drag",
  );
  assert.equal(control.get("one", "new-track"), undefined);
  control.set("one", "track", 70);
  assert.equal(
    control.get("one", "track"),
    70,
    "preview transfers to the pending request without reverting",
  );
  releases.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.get("one", "track"), undefined);
  control.preview("one", "track", 100);
  control.cancelPreview("one");
  assert.equal(control.get("one", "track"), undefined);
  assert.deepEqual(calls, [10, 70], "cancelling a drag never sends its position");
});
