import { MusicBot, log, type App } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { PlaylistStore } from "./store.ts";
import { PlaybackStore } from "./playback-store.ts";
import { startWebServer } from "./web.ts";

const config = loadConfig();
const app: App = {
  config,
  playlists: new PlaylistStore(),
  playback: new PlaybackStore(undefined, message => log("warn", message)),
  bots: [],
  searchResults: new Map(),
};
app.bots = config.bots.map((cfg, i) => new MusicBot(app, cfg, i));
// Saved defaults also follow edits made through TeamSpeak chat commands.
app.playlists.onChange = () => {
  for (const bot of app.bots) {
    if (!app.playlists.hasDefault(bot.name)) continue;
    const list = app.playlists.defaultFor(bot.name);
    bot.player.setDefaultPlaylist(list?.tracks ?? [], list?.name);
  }
};

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down...");
  await Promise.all(app.bots.map((b) => b.shutdown()));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log("info", `${app.bots.length} bot(s), ${app.playlists.all.length} saved playlist(s)`);
log("info", "Process started (PID " + process.pid + "); playback checkpoints enabled");
if (config.web.enabled) startWebServer(app);

// Stagger connections a little so several bots don't trip the server's flood protection.
for (const [i, bot] of app.bots.entries()) {
  setTimeout(() => {
    bot.start().catch((err: unknown) => bot.log("error", `Bot failed: ${err instanceof Error ? err.message : String(err)}`));
  }, i * 3000);
}
