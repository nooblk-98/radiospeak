import test from "node:test";
import assert from "node:assert/strict";
import { artistKey, spreadShuffle } from "../src/shuffle.ts";
import { fixture } from "./helpers.ts";

const song = (artist: string, n: number) => ({ url: `https://www.youtube.com/watch?v=${artist.replace(/\W/g, "").slice(0, 6)}${String(n).padStart(5, "0")}`, title: `${artist} ${n}`, artist, duration: 200 });
const mix = (counts: Record<string, number>) => Object.entries(counts).flatMap(([artist, count]) => Array.from({ length: count }, (_, n) => song(artist, n)));
const sideBySide = (order: { artist: string }[]) => order.slice(1).filter((t, i) => t.artist === order[i]!.artist).length;

test("artist-aware shuffle keeps every song and separates artists whenever the mix allows", () => {
  // The live queue that prompted this: two artists hold 55 of 66 songs.
  const queue = mix({ "Nate Kmar": 28, "Thisira Raviranga": 27, IRAJ: 4, "ROSHAN FERNANDO": 2, "M Entertainments": 2, a: 1, b: 1, c: 1 });
  const orders = new Set<string>();
  for (let run = 0; run < 200; run++) {
    const order = spreadShuffle(queue, artistKey);
    assert.deepEqual(order.map((t) => t.url).sort(), queue.map((t) => t.url).sort(), "no song lost or duplicated");
    assert.equal(sideBySide(order), 0, "no two songs by the same artist in a row");
    orders.add(order.map((t) => t.url).join());
  }
  assert.ok(orders.size > 150, "orders stay random");
  const lopsided = spreadShuffle(mix({ solo: 5, other: 1 }), artistKey);
  assert.equal(sideBySide(lopsided), 3, "when one artist dominates, repeats are kept to the unavoidable minimum");
  for (let run = 0; run < 50; run++) {
    assert.notEqual(artistKey(spreadShuffle(mix({ x: 3, y: 3 }), artistKey, artistKey({ artist: "x", url: "" }))[0]!), "artist:x", "starts away from what is playing");
  }
  assert.equal(artistKey({ artist: "Thisira Raviranga - Topic", url: "u1" }), artistKey({ artist: "thisira  raviranga", url: "u2" }));
  assert.notEqual(artistKey({ url: "https://a" }), artistKey({ url: "https://b" }), "unknown artists never count as the same artist");
});

test("shuffle spreads artists in the queue and in the idle playlist", async () => {
  const f = await fixture(), p = f.app.bots[0]!.player;
  try {
    p.stop();
    p.setShuffle(true);
    p.enqueue(mix({ A: 6, B: 6, C: 3 }));
    assert.equal(sideBySide([p.track!, ...p.queue] as { artist: string }[]), 0, "queued requests are spread out");
    p.stop();
    // Saved in artist blocks, which played as DDDD EEEE before.
    const idle = mix({ D: 4, E: 4, F: 2 });
    p.setDefaultPlaylist(idle, "Idle");
    p.playIfIdle();
    const played = [p.track!];
    for (let n = 1; n < idle.length; n++) { p.skip(); played.push(p.track!); }
    assert.deepEqual(played.map((t) => t.url).sort(), idle.map((t) => t.url).sort(), "one pass plays every idle song once");
    assert.equal(sideBySide(played as { artist: string }[]), 0, "the idle playlist is shuffled too");
    p.setShuffle(false);
    p.stop();
    p.setDefaultPlaylist(idle.slice(0, 3), "Ordered");
    p.playIfIdle();
    assert.equal(p.track?.url, idle[0]!.url, "with shuffle off the idle playlist keeps its saved order");
  } finally { await f.close(); }
});
