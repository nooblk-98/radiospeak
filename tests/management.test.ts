import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, tracks } from "./helpers.ts";
import { PlaylistStore } from "../src/library/store.ts";

test("portable exports merge atomically, remap references and exclude credentials and identities", async () => {
  const f = await fixture("a-private-master-password");
  try {
    const store = f.app.playlists,
      c = store.createCollection("Chill"),
      list = store.create("Evenings", c.id);
    store.addTracks(list, tracks.slice(0, 2));
    store.setDefault("Test bot", list);
    store.setNickname("Test bot", "Radio Lounge");
    store.setSettings("Test bot", {
      audioProfile: "balanced",
      failover: [store.radioStations[0]!.id],
    });
    const exported = await f.api("/api/transfer");
    assert.equal(exported.status, 200);
    const serialized = JSON.stringify(exported.data);
    for (const forbidden of [
      "accounts",
      "hash",
      "salt",
      "identityFile",
      "serverPassword",
      "a-private-master-password",
      "deployment-token",
    ])
      assert.ok(!serialized.includes(forbidden), forbidden);
    const before = store.revision;
    const preview = await f.api("/api/transfer", {
      archive: exported.data,
      applySettings: true,
      preview: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.playlists, 1);
    assert.equal(store.revision, before);
    const invalid = structuredClone(exported.data);
    invalid.data.playlists[0].tracks.push({ url: "file:///etc/passwd", title: "Bad" });
    assert.equal(
      (await f.api("/api/transfer", { archive: invalid, applySettings: true })).status,
      400,
    );
    assert.equal(store.revision, before);
    assert.equal(store.all.length, 1);
    const badPreferences = structuredClone(exported.data);
    badPreferences.players["Test bot"].volume = 101;
    assert.equal(
      (await f.api("/api/transfer", { archive: badPreferences, applySettings: true })).status,
      400,
    );
    assert.equal(store.revision, before);
    assert.equal(
      (await f.api("/api/transfer", { archive: exported.data, applySettings: true })).status,
      200,
    );
    const imported = store.all[1]!;
    assert.equal(imported.name, "Evenings (2)");
    assert.notEqual(imported.id, list.id);
    assert.notEqual(imported.collectionId, c.id);
    assert.equal(store.defaults["Test bot"], imported.id);
    assert.equal(store.settingsFor("Test bot").failover[0], store.radioStations[2]!.id);
    assert.equal(
      new PlaylistStore(store.path).all.length,
      2,
      "import response waits for durable library save",
    );
    assert.equal((await fetch(f.base + "/api/transfer")).status, 401);
  } finally {
    await f.close();
  }
});

test("filtered playlist pages retain original positions and bulk edits reject stale source/destination versions", async () => {
  const f = await fixture();
  try {
    const store = f.app.playlists,
      source = store.create("Source"),
      destination = store.create("Destination");
    store.addTracks(source, [
      tracks[0]!,
      tracks[1]!,
      { ...tracks[0]!, url: "https://youtu.be/abcdefghijk" },
      tracks[2]!,
    ]);
    const duplicate = await f.api("/api/playlists/" + source.id + "?duplicates=true");
    assert.deepEqual(duplicate.data.positions, [2]);
    const searched = await f.api("/api/playlists/" + source.id + "?q=night");
    assert.deepEqual(searched.data.positions, [1]);
    assert.equal(searched.data.trackCount, 4);
    const bulk = (value: object) =>
      f.api("/api/playlists/" + source.id + "/bulk", { expectedVersion: source.version, ...value });
    assert.equal(
      (
        await bulk({
          action: "copy",
          indices: [1],
          destination: destination.id,
          destinationVersion: "stale",
        })
      ).status,
      400,
    );
    assert.equal(destination.tracks.length, 0);
    assert.equal(
      (
        await bulk({
          action: "copy",
          indices: [2, 0, 0],
          destination: destination.id,
          destinationVersion: destination.version,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      destination.tracks.map((t) => t.title),
      [tracks[0]!.title, tracks[0]!.title],
    );
    assert.equal(
      (await bulk({ action: "deduplicate", allMatching: true, duplicates: true })).status,
      200,
    );
    assert.equal(source.tracks.length, 3);
    assert.equal(
      (await bulk({ action: "sort", indices: [0, 1, 2], sort: "duration" })).status,
      200,
    );
    assert.deepEqual(
      source.tracks.map((t) => t.duration),
      [185, 210, 244],
    );
    const old = source.version;
    store.addTracks(source, [tracks[3]!]);
    assert.equal(
      (await bulk({ action: "remove", indices: [0], expectedVersion: old })).status,
      409,
    );
    assert.equal(source.tracks.length, 4);
    assert.equal(
      (
        await bulk({
          action: "move",
          allMatching: true,
          q: "night",
          destination: destination.id,
          destinationVersion: destination.version,
        })
      ).status,
      200,
    );
    assert.equal(source.tracks.length, 3);
    assert.equal(destination.tracks.at(-1)!.title, "Night drive");
  } finally {
    await f.close();
  }
});

test("audit journal is durable, bounded, secret-free and restricted to administrators", async () => {
  const f = await fixture("owner-test-password");
  try {
    await f.api("/api/accounts", {
      username: "listener",
      role: "listener",
      password: "never-save-this-password",
    });
    const journal = await f.api("/api/audit");
    assert.equal(journal.data.entries[0].actor, "owner");
    assert.equal(journal.data.entries[0].resource, "api/accounts");
    const text = readFileSync(join(f.dir, "operations.json"), "utf8");
    assert.ok(!text.includes("never-save-this-password"));
    assert.ok(!text.includes("owner-test-password"));
    const login = await fetch(f.base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "listener", password: "never-save-this-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    for (const path of ["/api/audit", "/api/transfer"])
      assert.equal((await fetch(f.base + path, { headers: { Cookie: cookie } })).status, 403);
    for (let n = 0; n < 2010; n++) f.app.operations!.audit("test", "POST", "/api/bots/one/volume");
    assert.equal(f.app.operations!.entries().total, 2000);
    await f.app.operations!.flush();
  } finally {
    await f.close();
  }
});
