import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { MusicBot, type App } from "../src/bot.ts";
import { PlaylistStore } from "../src/store.ts";
import { startWebServer } from "../src/web.ts";

export const tracks = [
  { url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Evening breeze", duration: 210, artist: "Test artist" },
  { url: "https://soundcloud.com/example/night", title: "Night drive", duration: 185, artist: "Test channel", thumbnail: "https://example.com/art.jpg" },
  { url: "https://www.youtube.com/watch?v=lmnopqrstuv", title: "Blue hour", duration: 244 },
  { url: "https://www.youtube.com/watch?v=wxyzabcdefg", title: 'A long title <script>alert("unsafe")</script> & more music', duration: 300 },
];

/** Runs the real HTTP API and Player, paused so it needs no audio tools or TeamSpeak. */
export async function fixture(password = "") {
  const dir = mkdtempSync(join(tmpdir(), "radiospeak-test-"));
  const app: App = {
    config: {
      server: "127.0.0.1:9987", serverPassword: "", identityLevel: 8,
      ffmpegPath: process.execPath, ytdlpPath: process.execPath, bitrateKbps: 96,
      commandPrefix: "!", maxPlaylistItems: 300, admins: [], adminGroups: [],
      pauseWhenEmpty: true, emptyGraceSeconds: 15, showSongInNickname: true, songInDescription: true,
      web: { enabled: true, host: "127.0.0.1", port: 0, password },
      bots: [{ name: "Test bot", nickname: "Music bot", channel: "", channelPassword: "", identityFile: join(dir,"identity.txt"), volume: 50, defaultPlaylist: "" }],
    },
    playlists: new PlaylistStore(join(dir,"library.json")), bots: [], searchResults: new Map(),
  };
  app.bots = [new MusicBot(app, app.config.bots[0]!, 0)];
  app.bots[0]!.player.pause();
  // Avoid fixture process output; no TeamSpeak connection is started.
  app.bots[0]!.log = () => {};
  app.bots[0]!.player.enqueue(tracks.map(t=>({...t,requestedBy:"test"})));
  const server = startWebServer(app);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  const base = "http://127.0.0.1:" + address.port;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(password ? { Authorization:"Basic " + Buffer.from("test:"+password).toString("base64") } : {}), ...(body===undefined ? {} : {"Content-Type":"application/json"}) },
      ...(body===undefined ? {} : { body:JSON.stringify(body) }),
    });
    return { status:response.status, data:await response.json() };
  };
  return { app, base, api, dir, async close() {
    app.bots.forEach(b=>b.player.stop());
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
  }};
}
