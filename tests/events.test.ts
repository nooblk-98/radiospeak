import test from "node:test";
import assert from "node:assert/strict";
import { StateConnection } from "../src/web/state/connection.js";

class Source extends EventTarget {
  static current: Source;
  onerror: Function | undefined;
  closed = false;
  constructor(_url: string) {
    super();
    Source.current = this;
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}
test("SSE progress merges health without replacing library state or redrawing the main view", async () => {
  const keys = ["EventSource", "document", "fetch"];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const connection = new StateConnection();
  let renders = 0,
    progress = 0;
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
    let resolveFetch: Function;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () =>
        new Promise((accept) => {
          resolveFetch = accept;
        }),
    });
    connection.addEventListener("state", () => renders++);
    connection.addEventListener("playback_progress", () => progress++);
    connection.start();
    const base = {
      bots: [{ name: "one", track: null, queue: [], elapsed: 0 }],
      playlists: [{ id: "list", trackCount: 500 }],
      favorites: [],
    };
    Source.current.emit("state", base);
    assert.equal(renders, 1);
    const stale = connection.refresh();
    Source.current.emit("playback_progress", {
      bots: [{ name: "one", elapsed: 42, health: { underruns: 2 } }],
      system: { uptime: 80 },
    });
    resolveFetch!(new Response(JSON.stringify(base)));
    await stale;
    assert.equal(
      connection.state.bots[0].elapsed,
      42,
      "a late REST response must not overwrite newer pushed progress",
    );
    assert.equal(connection.state.playlists[0].trackCount, 500);
    assert.equal(renders, 1);
    assert.equal(progress, 2);
    connection.stop();
    assert.equal(Source.current.closed, true);
  } finally {
    connection.stop();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

test("a changed UI revision requests reload before accepting incompatible playlist state", () => {
  const saved = new Map(
    ["EventSource", "document"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const connection = new StateConnection({ uiVersion: "loaded" });
  let updates = 0,
    renders = 0;
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: Object.assign(new EventTarget(), { hidden: false }),
    });
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
    connection.addEventListener("updateavailable", () => updates++);
    connection.addEventListener("state", () => renders++);
    connection.start();
    const original = {
      uiVersion: "loaded",
      bots: [{ name: "one", track: null, queue: [], elapsed: 0 }],
      playlists: [{ id: "list", tracks: [] }],
    };
    Source.current.emit("state", original);
    Source.current.emit("playback_progress", {
      uiVersion: "updated",
      bots: [{ name: "one", elapsed: 10 }],
    });
    Source.current.emit("state", {
      uiVersion: "updated",
      bots: [],
      playlists: [{ id: "list", trackCount: 500 }],
    });
    assert.equal(updates, 1);
    assert.equal(renders, 1, "new state must not reach outdated UI code");
    assert.deepEqual(connection.state, original);
  } finally {
    connection.stop();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

test("control acknowledgements win over older progress and replacement instances reset revision scope", () => {
  const saved = new Map(
    ["EventSource", "document"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const connection = new StateConnection();
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: Object.assign(new EventTarget(), { hidden: false }),
    });
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
    connection.start();
    const bot = {
      name: "one",
      generation: "first",
      revision: 2,
      track: { url: "track-a" },
      volume: 50,
      elapsed: 1,
    };
    const base = { bots: [bot], playlists: [], favorites: [] };
    Source.current.emit("state", base);
    connection.applyPlayback({
      name: "one",
      generation: "first",
      revision: 4,
      trackUrl: "track-a",
      elapsed: 50.5,
      volume: 25,
    });
    Source.current.emit("playback_progress", {
      bots: [{ name: "one", generation: "first", revision: 3, elapsed: 1.5 }],
    });
    Source.current.emit("state", base);
    assert.equal(connection.state.bots[0].elapsed, 50.5);
    assert.equal(connection.state.bots[0].volume, 25);
    Source.current.emit("state", {
      ...base,
      bots: [{ ...bot, generation: "replacement", revision: 0 }],
    });
    assert.equal(connection.state.bots[0].generation, "replacement");
    connection.applyPlayback({
      name: "one",
      generation: "first",
      revision: 100,
      trackUrl: "track-a",
      elapsed: 150,
    });
    assert.equal(
      connection.state.bots[0].elapsed,
      1,
      "late responses from the previous instance are discarded",
    );
  } finally {
    connection.stop();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
