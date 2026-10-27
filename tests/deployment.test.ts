import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sourceRevision } from "../src/shared/build-info.ts";

test("deployment checks skip a healthy revision and a lost webhook response never causes a duplicate trigger", async () => {
  let ready = true,
    triggers = 0;
  const server = createServer((req, res) => {
    if (req.url === "/webhook") {
      triggers++;
      ready = true;
      res.destroy();
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: true, ready, sourceRevision }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const run = (script: string) =>
    promisify(execFile)(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        DEPLOY_HEALTH_URL: base + "/healthz",
        WEBHOOK_URL: base + "/webhook",
        FORCE_REDEPLOY: "false",
      },
      windowsHide: true,
    });
  try {
    assert.match((await run("scripts/deploy.mjs")).stdout, /already healthy/);
    assert.equal(triggers, 0);
    ready = false;
    await run("scripts/deploy.mjs");
    assert.equal(triggers, 1);
    assert.match(
      (await run("scripts/check-deployment.mjs")).stdout,
      /Expected source revision is healthy/,
    );
    await run("scripts/deploy.mjs");
    assert.equal(triggers, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
