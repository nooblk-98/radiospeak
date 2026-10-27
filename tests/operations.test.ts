import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, tracks } from "./helpers.ts";
import { PlaylistStore } from "../src/library/store.ts";
import { activeSchedule } from "../src/domain/policies.ts";
import { Player } from "../src/audio/player.ts";
import { ImportManager } from "../src/library/imports.ts";
import { runCommand } from "../src/bots/teamspeak/commands.ts";

const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
test("library writes coalesce and flush the newest generation; unrelated edits do not reload idle tracks", async (t) => {
  const f = await fixture();
  try {
    const list = f.app.playlists.create("Idle");
    f.app.playlists.addTracks(list, tracks.slice(0, 2));
    f.app.playlists.setDefault("Test bot", list);
    const bot = f.app.bots[0]!;
    bot.syncLibrary();
    const sync = t.mock.method(bot.player, "setDefaultPlaylist", () => {});
    f.app.playlists.onChange = () => bot.syncLibrary();
    for (let n = 0; n < 100; n++) f.app.playlists.setNickname("Test bot", "Radio " + n);
    const writing = f.app.playlists.flush();
    f.app.playlists.setNickname("Test bot", "Final radio");
    await writing;
    await f.app.playlists.flush();
    assert.equal(new PlaylistStore(f.app.playlists.path).nicknameFor("Test bot"), "Final radio");
    assert.equal(sync.mock.callCount(), 0);
    f.app.playlists.addTracks(list, [tracks[2]!]);
    assert.equal(sync.mock.callCount(), 1);
    assert.equal(JSON.parse(readFileSync(f.app.playlists.path, "utf8")).version, 2);
  } finally {
    await f.close();
  }
});

test("overnight schedules use the starting weekday and zone, reject overlaps and preserve requested playback", async () => {
  const f = await fixture();
  try {
    const store = f.app.playlists,
      list = store.create("Night"),
      day = store.create("Day");
    store.addTracks(list, [tracks[1]!]);
    store.addTracks(day, [tracks[2]!]);
    store.setDefault("Test bot", day);
    const schedule = store.saveSchedule({
      bot: "Test bot",
      playlistId: list.id,
      days: [0],
      start: "23:00",
      end: "01:00",
      timezone: "Asia/Colombo",
      enabled: true,
    });
    assert.equal(
      activeSchedule(store.schedules, "Test bot", new Date("2026-10-25T18:00:00Z"))?.id,
      schedule.id,
    );
    assert.equal(
      activeSchedule(store.schedules, "Test bot", new Date("2026-10-25T19:00:00Z"))?.id,
      schedule.id,
    );
    assert.equal(
      activeSchedule(store.schedules, "Test bot", new Date("2026-10-25T19:30:00Z")),
      undefined,
    );
    assert.throws(
      () => store.saveSchedule({ ...schedule, days: [1], start: "00:30", end: "02:00" }),
      /overlaps/,
    );
    const player = f.app.bots[0]!.player,
      current = player.track?.url;
    f.app.bots[0]!.syncLibrary(new Date("2026-10-25T18:00:00Z"));
    assert.equal(player.defaultPlaylist.name, "Night");
    assert.equal(player.track?.url, current);
    f.app.bots[0]!.syncLibrary(new Date("2026-10-25T20:00:00Z"));
    assert.equal(player.defaultPlaylist.name, "Day");
    await store.flush();
    assert.equal(new PlaylistStore(store.path).schedules.length, 1);
  } finally {
    await f.close();
  }
});

test("queue limits reject whole requests without changing playback and idle selection avoids recent tracks", () => {
  const player = new Player({
    ffmpegPath: "unused",
    ytdlpPath: "unused",
    volume: 50,
    bitrateKbps: 96,
    connectionPaused: true,
    sendFrame() {},
    log() {},
  });
  try {
    player.configure({
      audioProfile: "balanced",
      queue: { maxTracks: 2, perRequester: 1, cooldownSeconds: 0 },
      avoidRecent: 1,
      idleReleaseSeconds: 15,
      failover: [],
    });
    player.setRecentTracks([tracks[0]!.url]);
    player.setDefaultPlaylist(tracks.slice(0, 2), "Idle");
    assert.equal(player.track?.url, tracks[1]!.url);
    player.enqueue([tracks[2]!]);
    const current = player.track?.url,
      order = player.queue.map((t) => t.url);
    assert.throws(() => player.enqueue(tracks), /Queue limit/);
    assert.equal(player.track?.url, current);
    assert.deepEqual(
      player.queue.map((t) => t.url),
      order,
    );
    assert.throws(() => player.playNow(tracks, true), /Queue limit/);
    assert.equal(player.track?.url, current);
  } finally {
    player.stop();
  }
});

test("accounts enforce listener/DJ/admin boundaries, stable request ownership and live revocation", async () => {
  const f = await fixture("owner-password");
  const login = async (username: string, password: string) => {
    const response = await fetch(f.base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const call = async (
    cookie: string,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(f.base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    for (const [username, role] of [
      ["alice", "listener"],
      ["deejay", "dj"],
    ])
      assert.equal(
        (await f.api("/api/accounts", { username, role, password: "test-password-strong" })).status,
        200,
      );
    const alice = await login("alice", "test-password-strong"),
      dj = await login("deejay", "test-password-strong"),
      path = "/api/bots/Test%20bot/";
    assert.equal((await call(alice, "/api/state")).data.viewer.role, "listener");
    assert.equal((await call(alice, path + "volume", { volume: 1 })).status, 403);
    assert.equal(
      (
        await call(alice, "/api/accounts", {
          username: "escape",
          role: "admin",
          password: "test-password-strong",
        })
      ).status,
      403,
    );
    assert.equal((await call(dj, "/api/bots", { name: "extra" })).status, 403);
    assert.equal((await call(dj, path + "volume", { volume: 25 })).status, 200);
    await f.api(path + "settings", {
      settings: { queue: { maxTracks: 20, perRequester: 1, cooldownSeconds: 0 } },
    });
    assert.equal(
      (await call(alice, path + "enqueue", { tracks: [tracks[1]], requesterId: "web:owner" }))
        .status,
      200,
    );
    assert.equal(f.app.bots[0]!.player.queue.at(-1)?.requesterId, "web:alice");
    assert.equal((await call(alice, path + "enqueue", { tracks: [tracks[2]] })).status, 400);
    assert.equal((await call(alice, path + "remove", { position: 1 })).status, 403);
    assert.equal(
      (await call(alice, path + "remove", { position: f.app.bots[0]!.player.queue.length })).status,
      200,
    );
    assert.equal((await call(alice, path + "vote-skip", {})).status, 200);
    const access = (await f.api("/api/access")).data;
    assert.equal(JSON.stringify(access).includes('"hash"'), false);
    const stream = await fetch(f.base + "/api/events", {
      headers: { Cookie: alice },
      signal: AbortSignal.timeout(4000),
    });
    const reader = stream.body!.getReader();
    await reader.read();
    await f.api("/api/accounts/alice", {}, "DELETE");
    assert.equal((await call(alice, "/api/state")).status, 401);
    let ended = false;
    while (!ended) {
      const part = await reader.read();
      ended = part.done;
    }
    assert.equal(ended, true, "revoked accounts must lose already-open event streams");
  } finally {
    await f.close();
  }
});

test("TeamSpeak roles are opt-in and enforce DJ controls, stable identities and requester cooldowns", async () => {
  const f = await fixture();
  try {
    const bot = f.app.bots[0]!,
      msg: any = {
        invokerUID: "listener-uid",
        invokerName: "Listener",
        invokerID: 1n,
        invokerGroups: [],
        message: "!vol 25",
      };
    await runCommand(f.app, bot, msg);
    assert.equal(
      bot.player.volume,
      25,
      "legacy chat behavior remains available before enforcement",
    );
    f.app.playlists.setChatAccess({
      enabled: true,
      users: { "dj-uid": "dj" },
      groups: { "42": "admin" },
    });
    msg.message = "!vol 5";
    assert.match((await runCommand(f.app, bot, msg))!, /DJ/);
    assert.equal(bot.player.volume, 25);
    const found = f.app.searchResults;
    found.set(msg.invokerUID, [tracks[1]!]);
    msg.message = "!pick 1";
    assert.match((await runCommand(f.app, bot, msg))!, /Queued/);
    assert.equal(bot.player.queue.at(-1)?.requesterId, "ts:listener-uid");
    await assert.rejects(runCommand(f.app, bot, msg), /Wait 3 seconds/);
    msg.invokerUID = "dj-uid";
    msg.message = "!vol 5";
    await runCommand(f.app, bot, msg);
    assert.equal(bot.player.volume, 5);
    assert.equal(bot.chatRole("other", [42n]), "admin");
  } finally {
    await f.close();
  }
});

test("streamed imports persist a cursor, resume larger playlists and retry entries without duplicating saved tracks", async () => {
  const f = await fixture();
  let manager: ImportManager | undefined;
  try {
    const list = f.app.playlists.create("Resume me"),
      starts: number[] = [];
    const resolver = async (_path: string, _input: string, options: any) => {
      const start = options.startIndex || 1;
      starts.push(start);
      const entries = [{ index: start, track: tracks[(start - 1) % tracks.length]! }];
      options.onEntry?.(entries[0]);
      options.onProgress?.({ processed: 1, total: 3, title: entries[0]!.track.title });
      return { tracks: entries.map((e) => e.track), entries, total: 3 };
    };
    manager = new ImportManager(f.app.playlists, "unused", 1, resolver);
    const job = manager.start(list.id, "https://example.com/public", false);
    await until(() => job.status === "completed" && manager!.active === 0);
    assert.equal(job.hasMore, true);
    assert.equal(job.nextIndex, 2);
    await manager.shutdown();
    manager = new ImportManager(f.app.playlists, "unused", 1, resolver);
    manager.resume(job.id);
    await until(() => manager!.get(job.id)?.status === "completed" && manager!.active === 0);
    assert.equal(list.tracks.length, 2);
    assert.deepEqual(starts, [1, 2]);
    manager.resume(job.id, true);
    await until(() => manager!.get(job.id)?.status === "completed" && manager!.active === 0);
    assert.equal(
      list.tracks.length,
      2,
      "replaying the same import entries is idempotent even when URL deduplication is off",
    );
  } finally {
    await manager?.shutdown();
    await f.close();
  }
});

test("shutdown saves a partially streamed import and a new manager resumes at the durable cursor", async () => {
  const f = await fixture();
  let manager: ImportManager | undefined;
  try {
    const list = f.app.playlists.create("Interrupted import");
    manager = new ImportManager(f.app.playlists, "unused", 30, async (_path, _input, options) => {
      for (let i = 1; i <= 20; i++)
        options.onEntry?.({
          index: i,
          track: { url: "https://example.com/interrupted/" + i, title: "Track " + i },
        });
      await new Promise((_accept, reject) =>
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        }),
      );
      return { tracks: [] };
    });
    const job = manager.start(list.id, "https://example.com/interrupted", false);
    await until(() => job.nextIndex === 21);
    await manager.shutdown();
    assert.equal(job.status, "interrupted");
    const restored = new PlaylistStore(f.app.playlists.path);
    manager = new ImportManager(restored, "unused", 30, async (_path, _input, options) => {
      assert.equal(options.startIndex, 21);
      return {
        tracks: [{ url: "https://example.com/interrupted/21", title: "Track 21" }],
        entries: [
          { index: 21, track: { url: "https://example.com/interrupted/21", title: "Track 21" } },
        ],
        total: 21,
      };
    });
    manager.resume(job.id);
    await until(() => manager!.get(job.id)?.status === "completed" && manager!.active === 0);
    assert.equal(restored.find(list.id)!.tracks.length, 21);
    assert.equal(manager.get(job.id)!.hasMore, false);
  } finally {
    await manager?.shutdown();
    await f.close();
  }
});

test("retrying unavailable entries targets just their provider positions", async () => {
  const f = await fixture();
  let manager: ImportManager | undefined,
    calls = 0;
  try {
    const list = f.app.playlists.create("Retry entries");
    manager = new ImportManager(f.app.playlists, "unused", 300, async (_path, _input, options) => {
      calls++;
      if (calls === 1)
        return {
          tracks: [tracks[0]!, tracks[2]!],
          entries: [
            { index: 1, track: tracks[0]! },
            { index: 2, error: "Private video" },
            { index: 3, track: tracks[2]! },
          ],
          total: 3,
          skipped: ["Private video"],
        };
      assert.equal(options.startIndex, 2);
      assert.equal(options.maxItems, 1);
      return { tracks: [tracks[1]!], entries: [{ index: 2, track: tracks[1]! }], total: 3 };
    });
    const job = manager.start(list.id, "https://example.com/retry");
    await until(() => job.status === "completed" && manager!.active === 0);
    assert.equal(job.failed, 1);
    assert.deepEqual(job.failedIndices, [2]);
    manager.resume(job.id, true);
    await until(() => job.status === "completed" && manager!.active === 0);
    assert.equal(job.failed, 0);
    assert.equal(list.tracks.length, 3);
    assert.equal(calls, 2);
  } finally {
    await manager?.shutdown();
    await f.close();
  }
});
