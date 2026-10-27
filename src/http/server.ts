/** HTTP lifecycle, authentication, static assets, and the shared real-time event stream. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { type App } from "../app/context.ts";
import { type Viewer } from "../domain/policies.ts";
import { Operations } from "../operations/audit-store.ts";
import { AuthError, WebAuth } from "../security/web-auth.ts";
import { sourceRevision } from "../shared/build-info.ts";
import { log } from "../shared/logger.ts";

import { assets, loginPage, uiVersion } from "./assets.ts";
import { imports } from "./context.ts";
import { HttpError, readJson, str } from "./helpers.ts";
import { route } from "./routes.ts";
import { stateFor, stateForSystem } from "./state.ts";

export function startWebServer(app: App) {
  app.operations ??= new Operations(app);
  const { host, port, password } = app.config.web;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const peers = new Set<ServerResponse>();
  const sessions = new Map<ServerResponse, { req: IncomingMessage; viewer: Viewer }>();
  const auth = new WebAuth(password, () => app.playlists.accounts);
  let previous = "",
    sequence = 0;
  const write = (res: ServerResponse, frame: string) => {
    if (res.destroyed || res.writableLength > 256 * 1024) {
      peers.delete(res);
      res.end();
      return;
    }
    res.write(frame);
  };
  const frame = (event: string, payload: unknown) =>
    "id: " + ++sequence + "\nevent: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  const system = () => ({
    ...stateForSystem(),
    libraryError: app.playlists.persistenceError,
    eventLoopLagMs: Number.isFinite(lag.mean) ? Math.round(lag.mean / 1e6) : 0,
    eventLoopP99Ms: Math.round(lag.percentile(99) / 1e6),
  });
  const withHealth = () => ({ ...stateFor(app), system: system() });
  const revision = () =>
    [
      app.playlists.revision,
      imports(app).revision,
      app.operations?.revision,
      ...app.bots.map((b) => b.name + ":" + b.revision),
    ].join("|");
  const timer = setInterval(() => {
    if (!peers.size) return;
    for (const [peer, session] of sessions) {
      const viewer = auth.viewer(session.req, true);
      if (!viewer || viewer.role !== session.viewer.role) {
        peers.delete(peer);
        sessions.delete(peer);
        peer.end();
      }
    }
    if (!peers.size) return;
    const key = revision();
    if (key !== previous) {
      previous = key;
      const message = frame("state", withHealth());
      for (const peer of peers) write(peer, message);
    } else {
      const progress = {
        uiVersion,
        bots: app.bots.map((b) => ({
          name: b.name,
          revision: b.revision,
          generation: b.generation,
          elapsed: b.player.elapsed,
          health: b.health,
        })),
        system: system(),
      };
      const message = frame("playback_progress", progress);
      for (const peer of peers) write(peer, message);
    }
    lag.reset();
  }, 1000).unref();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respondError = (err: unknown) => {
      if (res.destroyed || res.headersSent) return;
      const status = err instanceof HttpError || err instanceof AuthError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      res
        .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: message }));
    };
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      res
        .writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...headers,
        })
        .end(JSON.stringify(data));
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz" && req.method === "GET") {
        const ready =
          app.bots.every((b) => b.connected) &&
          !app.playlists.persistenceError &&
          !app.playback?.status.error;
        json({
          ok: true,
          ready,
          sourceRevision,
          uiVersion,
          bots: app.bots.length,
          activeImports: imports(app).active,
        });
        return;
      }
      const api = url.pathname.startsWith("/api/");
      if (url.pathname === "/login" && req.method === "GET") {
        if (!auth.authorized(req, false)) {
          res
            .writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
            })
            .end(loginPage);
        } else res.writeHead(302, { Location: "/" }).end();
        return;
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        readJson(req)
          .then(async (body) => {
            json(
              { message: "Signed in." },
              {
                "Set-Cookie": await auth.login(
                  req,
                  typeof body.password === "string" ? body.password : "",
                  body.remember === true,
                  str(body.username) || "owner",
                ),
              },
            );
          })
          .catch(respondError);
        return;
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        json({ message: "Signed out." }, { "Set-Cookie": auth.logout(req) });
        return;
      }
      if (!auth.authorized(req, api)) {
        // Pages go to the login form; API calls get JSON (no Basic challenge, so browsers show no popup).
        if (!api && req.method === "GET")
          res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }).end();
        else
          res
            .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
            .end(JSON.stringify({ error: "Sign in to continue." }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.setTimeout(0);
        peers.add(res);
        const viewer = auth.viewer(req, true)!;
        sessions.set(res, { req, viewer });
        write(res, frame("state", { ...withHealth(), viewer }));
        res.on("close", () => {
          peers.delete(res);
          sessions.delete(res);
        });
        return;
      }
      const asset = req.method === "GET" ? assets.get(url.pathname) : undefined;
      if (asset) {
        res
          .writeHead(200, {
            "Content-Type": asset.type + "; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          .end(asset.body);
        return;
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort(new Error("Request cancelled"));
      };
      res.on("close", onClose);
      route(app, req, url, controller.signal, auth.viewer(req, api))
        .then(async (data) => {
          if (req.method !== "GET") {
            await app.playlists.flush();
            if (!["/api/search", "/api/imports/preview"].includes(url.pathname))
              app.operations!.audit(
                auth.viewer(req, api)!.username,
                req.method ?? "POST",
                url.pathname,
              );
            await app.operations!.flush();
          }
          if (!res.destroyed) json(data);
        })
        .catch(respondError)
        .finally(() => res.off("close", onClose));
    } catch (err) {
      respondError(err);
    }
  });
  server.on("error", (err) => log("error", "Web panel failed: " + err.message));
  server.on("close", () => {
    clearInterval(timer);
    lag.disable();
    imports(app).close();
    app.operations?.close();
    for (const peer of peers) peer.end();
    peers.clear();
    sessions.clear();
  });
  server.listen(port, host, () => {
    log("info", "Web panel on http://" + (host === "0.0.0.0" ? "localhost" : host) + ":" + port);
    if (!password && !["127.0.0.1", "localhost", "::1"].includes(host))
      log("warn", "Web panel has no password and is reachable from the network. Set web.password!");
  });
  return server;
}
