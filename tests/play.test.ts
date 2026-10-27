import assert from "node:assert/strict";
import test from "node:test";
import { PlayControl } from "../src/web/features/play.js";
import { playbackStatus } from "../src/web/ui/playback.js";
import { fixture, tracks } from "./helpers.ts";

test("Play now rejects repeated clicks through requesting and preparing, independently for each bot", async () => {
  let release!: () => void,
    calls = 0;
  const bot: any = { name: "one", track: null, health: { phase: "idle" } };
  const control = new PlayControl({
    send: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      bot.track = tracks[0];
      bot.health = { phase: "resolving", buffering: true };
    },
  });
  const pending = control.play(bot, tracks[0]);
  assert.equal(control.state(bot, tracks[0]), "requesting");
  assert.equal(control.state(bot, tracks[1]), "busy");
  assert.equal(await control.play(bot, tracks[0]), false);
  release();
  await pending;
  assert.equal(
    control.state(bot, { ...tracks[0], url: "https://youtu.be/abcdefghijk" }),
    "preparing",
  );
  assert.equal(await control.play(bot, tracks[0]), false);
  assert.equal(calls, 1);
  assert.equal(control.state({ ...bot, name: "two", track: null }, tracks[0]), "idle");
  bot.health = { phase: "playing", buffering: false };
  assert.equal(
    control.state(bot, tracks[0]),
    "idle",
    "an intentional replay remains available after audio starts",
  );
});

test("playback labels distinguish preparation, playback and listener/connection pauses", () => {
  const bot = { track: tracks[0], health: { phase: "resolving", buffering: true } };
  assert.equal(playbackStatus(bot).label, "Resolving audio stream…");
  assert.equal(
    playbackStatus({ ...bot, health: { phase: "buffering", buffering: true } }).label,
    "Preparing audio…",
  );
  assert.equal(
    playbackStatus({ ...bot, health: { phase: "playing", buffering: false } }).loading,
    false,
  );
  assert.equal(playbackStatus({ ...bot, autoPaused: true }).label, "Paused · no listeners");
  assert.equal(playbackStatus({ ...bot, connectionPaused: true }).phase, "connecting");
  assert.equal(playbackStatus({ track: null, radio: null }).phase, "idle");
});

test("duplicate Play now requests cannot repeatedly restart a song that is still preparing", async () => {
  const f = await fixture();
  try {
    const bot = f.app.bots[0]!,
      path = "/api/bots/Test%20bot/play-now";
    await f.api(path, { tracks: [tracks[1]], unique: true });
    const revision = bot.revision;
    const response = await f.api(path, { tracks: [{ ...tracks[1] }], unique: true });
    assert.equal(response.status, 200);
    assert.match(response.data.message, /already being prepared/);
    assert.equal(bot.revision, revision);
  } finally {
    await f.close();
  }
});
