import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assets, uiVersion } from "../src/http/assets.ts";
import { fixture } from "./helpers.ts";

test("the authenticated panel serves every revisioned module and preserves legacy asset URLs", async () => {
  const f = await fixture("asset-test-password");
  try {
    const login = await fetch(f.base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "asset-test-password" }),
    });
    const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    const visited = new Set<string>();
    async function visit(path: string): Promise<void> {
      if (visited.has(path)) return;
      visited.add(path);
      const response = await fetch(f.base + path, { headers });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type")!, /javascript/);
      const body = await response.text();
      for (const match of body.matchAll(/\b(?:from|import)\s*["']([^"']+\.js[^"']*)["']/g)) {
        const target = new URL(match[1]!, f.base + path);
        assert.equal(target.searchParams.get("v"), uiVersion, target.pathname);
        await visit(target.pathname + target.search);
      }
    }
    await visit("/app.js?v=" + uiVersion);
    for (const path of [
      "/api.js",
      "/components.js",
      "/volume.js",
      "/notifications.js",
      "/platforms.js",
      "/management.js",
      "/operations.js",
      "/enqueue.js",
    ])
      await visit(path);
    assert.ok(visited.has("/views/library.js?v=" + uiVersion));
    assert.ok(visited.has("/ui/format.js?v=" + uiVersion));
    for (const path of ["/discord.svg", "/teamspeak.svg", "/styles.css"]) {
      assert.equal((await fetch(f.base + path, { headers })).status, 200);
    }
    assert.equal((await fetch(f.base + "/styles.css", { redirect: "manual" })).status, 302);
    assert.equal((await fetch(f.base + "/bots/discord/credentials.ts", { headers })).status, 404);
  } finally {
    await f.close();
  }
});

test("CSS is served in its source order as one cached stylesheet", () => {
  const entry = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const imports = [...entry.matchAll(/@import\s+["']([^"']+)["'];/g)];
  assert.ok(imports.length > 1);
  const served = assets.get("/styles.css")!.body.toString("utf8");
  const expected = entry.replace(/@import\s+["']([^"']+)["'];/g, (_, path: string) =>
    readFileSync(new URL(path, new URL("../src/web/styles.css", import.meta.url)), "utf8"),
  );
  assert.equal(served, expected);
  assert.doesNotMatch(served, /@import/);
  assert.ok(served.indexOf(".player-dock") < served.indexOf("/* Phone and tablet polish"));
});
