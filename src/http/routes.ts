/** API dispatch and role checks. Persistence and audit flushing stay in the server boundary. */
import { randomUUID } from "node:crypto";
import { type IncomingMessage } from "node:http";
import { type App } from "../app/context.ts";
import type { LoopMode } from "../audio/player.ts";
import { checkDiscordSlot, createBot, discordInstances } from "../bots/factory.ts";
import {
  instanceConfig,
  validateBotName,
  validateDiscordConfig,
  validateNickname,
} from "../config/config.ts";
import { owner, type PlaylistSchedule, type Role, type Viewer } from "../domain/policies.ts";
import { playlistId, resolve } from "../media/ytdlp.ts";
import { createAccount } from "../security/accounts.ts";

import {
  changeInstance,
  imports,
  MAX_INSTANCES,
  panelManaged,
  selectedBot,
  syncDefaults,
} from "./context.ts";
import {
  checkOrder,
  HttpError,
  plain,
  readJson,
  str,
  streamUrl,
  trackJson,
  tracksFrom,
} from "./helpers.ts";
import { botAction } from "./player-actions.ts";
import { stateFor } from "./state.ts";

/** Search results come in pages of 10, up to 50 in total. */
const SEARCH_PAGE_SIZE = 10;
const SEARCH_PAGES = 5;
export async function route(
  app: App,
  req: IncomingMessage,
  url: URL,
  signal?: AbortSignal,
  viewer: Viewer = owner,
): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const store = app.playlists;
  if (["transfer", "audit"].includes(parts[1] ?? "")) {
    if (viewer.role !== "admin") throw new HttpError(403, "Administrator access required");
    if (parts[1] === "audit" && method === "GET")
      return app.operations?.entries(Math.max(0, Number(url.searchParams.get("offset")) || 0));
    if (parts[1] === "transfer") {
      if (method === "GET")
        return {
          ...store.exportLibrary(),
          players: Object.fromEntries(
            app.bots.map((b) => [
              b.name,
              {
                volume: b.player.volume,
                normalization: b.player.normalization,
                loop: b.player.loop,
                shuffle: b.player.shuffleEnabled,
                prebuffer: b.player.health.prebufferEnabled,
              },
            ]),
          ),
        };
      if (method === "POST") {
        const body = await readJson(req, 16 * 1024 * 1024);
        const archive = body.archive as {
          players?: Record<
            string,
            {
              volume: number;
              normalization: boolean;
              loop: LoopMode;
              shuffle: boolean;
              prebuffer: boolean;
            }
          >;
        };
        if (body.applySettings === true && archive?.players !== undefined) {
          if (
            !archive.players ||
            typeof archive.players !== "object" ||
            Array.isArray(archive.players)
          )
            throw new HttpError(400, "Invalid player preferences");
          for (const settings of Object.values(archive.players))
            if (
              !settings ||
              !Number.isInteger(settings.volume) ||
              settings.volume < 0 ||
              settings.volume > 100 ||
              !["off", "all", "one"].includes(settings.loop) ||
              ![settings.normalization, settings.shuffle, settings.prebuffer].every(
                (v) => typeof v === "boolean",
              )
            )
              throw new HttpError(400, "Invalid player preferences");
        }
        if (imports(app).active)
          throw new HttpError(
            409,
            "Wait for active playlist imports to finish before importing settings",
          );
        const result = store.importLibrary(
          body.archive,
          body.applySettings === true,
          app.bots.map((b) => b.name),
          body.preview === true,
        );
        if (body.preview !== true) {
          syncDefaults(app);
          if (body.applySettings === true) {
            for (const bot of app.bots) {
              const nickname = store.nicknameFor(bot.name);
              if (nickname && nickname !== bot.nickname)
                void bot.setNickname(nickname).catch(() => {});
              const settings = archive.players?.[bot.name];
              if (settings) {
                bot.player.setVolume(settings.volume);
                bot.player.setLoop(settings.loop);
                if (bot.player.shuffleEnabled !== settings.shuffle)
                  bot.player.setShuffle(settings.shuffle);
                if (bot.player.normalization !== settings.normalization)
                  bot.player.setNormalization(settings.normalization);
                bot.player.setPrebuffer(settings.prebuffer);
              }
            }
          }
          await app.playback?.flush();
        }
        return {
          ...result,
          message:
            body.preview === true
              ? "Export validated. Review the counts before importing."
              : "Settings and playlists imported.",
        };
      }
    }
    throw new HttpError(405, "Unsupported operation");
  }
  if (method !== "GET" && viewer.role !== "admin") {
    if (
      ["access", "accounts"].includes(parts[1] ?? "") ||
      (parts[1] === "bots" && (parts.length <= 3 || parts[3] === "connection"))
    )
      throw new HttpError(403, "An administrator manages accounts and instances");
    if (viewer.role === "listener") {
      const allowed =
        (parts[1] === "bots" &&
          ["enqueue", "play", "vote-skip", "remove", "undo"].includes(parts[3] ?? "")) ||
        (parts[1] === "playlists" && parts[3] === "play");
      if (!allowed) throw new HttpError(403, "A DJ manages playback and playlists");
    }
  }
  if (method === "GET" && url.pathname === "/api/state") {
    return { ...stateFor(app), viewer };
  }
  if (parts[1] === "bots" && parts[2] && parts[3] === "history" && method === "GET") {
    const bot = selectedBot(app, parts[2]);
    return {
      entries: store.historyFor(bot.name).map((h) => ({ ...h, track: trackJson(h.track) })),
    };
  }
  if (parts[1] === "access") {
    if (viewer.role !== "admin") throw new HttpError(403, "Administrator access required");
    if (method === "POST")
      store.setChatAccess(
        (await readJson(req)).chatAccess as Parameters<typeof store.setChatAccess>[0],
      );
    return {
      accounts: store.accounts.map(({ username, role }) => ({ username, role })),
      chatAccess: store.chatAccess,
    };
  }
  if (parts[1] === "accounts") {
    if (viewer.role !== "admin" || !app.config.web.password)
      throw new HttpError(403, "Set a panel administrator password before managing accounts");
    if (method === "POST") {
      const body = await readJson(req),
        username = str(body.username).toLowerCase(),
        role = str(body.role) as Role;
      const current = store.accounts.find((a) => a.username === username);
      if (str(body.password))
        store.saveAccount(await createAccount(username, String(body.password), role));
      else if (current) store.saveAccount({ ...current, role, version: randomUUID() });
      else throw new HttpError(400, "A new account needs a password");
      return { message: "Account saved. Existing sessions for it have been signed out." };
    }
    if (method === "DELETE" && parts[2]) {
      await readJson(req);
      store.deleteAccount(parts[2]);
      return { message: "Account removed." };
    }
  }
  if (parts[1] === "schedules") {
    if (method === "DELETE" && parts[2]) {
      await readJson(req);
      store.deleteSchedule(parts[2]);
      syncDefaults(app);
      return { message: "Schedule removed." };
    }
    if (method === "POST" || method === "PATCH") {
      const body = await readJson(req);
      selectedBot(app, body.bot);
      const value = {
        bot: str(body.bot),
        playlistId: str(body.playlistId),
        timezone: str(body.timezone) || "Asia/Colombo",
        days: body.days,
        start: str(body.start),
        end: str(body.end),
        enabled: body.enabled === true,
      } as Omit<PlaylistSchedule, "id">;
      const schedule = store.saveSchedule(value, parts[2]);
      syncDefaults(app);
      return { message: "Schedule saved.", schedule };
    }
  }
  if (method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q || q.length > 1000)
      throw new HttpError(400, "Enter a search or public media URL (up to 1,000 characters)");
    const source = url.searchParams.get("source") === "soundcloud" ? "soundcloud" : "youtube";
    // Pages of SEARCH_PAGE_SIZE; later pages may simply come back empty.
    const page = Math.min(
      SEARCH_PAGES,
      Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)),
    );
    const startIndex = (page - 1) * SEARCH_PAGE_SIZE + 1;
    if (url.searchParams.get("type") === "playlists") {
      if (source !== "youtube")
        throw new HttpError(400, "Playlist search is available for YouTube only");
      // YouTube's own results page, filtered to playlists (sp=EgIQAw==).
      const results = new URL("https://www.youtube.com/results");
      results.searchParams.set("search_query", q);
      results.searchParams.set("sp", "EgIQAw==");
      try {
        const found = await resolve(app.config.ytdlpPath, results.href, {
          maxItems: SEARCH_PAGE_SIZE,
          startIndex,
          partial: true,
          signal,
        });
        return found.tracks
          .filter((t) => playlistId(t.url) && !new URL(t.url).searchParams.has("v"))
          .map(trackJson);
      } catch (err) {
        if (err instanceof Error && /^Nothing playable/.test(err.message)) return [];
        throw err;
      }
    }
    return (
      await resolve(app.config.ytdlpPath, q, {
        maxItems: SEARCH_PAGE_SIZE,
        results: page * SEARCH_PAGE_SIZE,
        startIndex,
        partial: page > 1,
        source,
        signal,
      })
    ).tracks.map(trackJson);
  }
  if (url.pathname === "/api/imports/preview" && method === "POST")
    return imports(app).preview(str((await readJson(req)).input), signal);
  if (url.pathname === "/api/imports" && method === "POST") {
    const body = await readJson(req);
    return {
      message: "Import started.",
      job: imports(app).start(str(body.playlistId), str(body.input), body.skipDuplicates !== false),
    };
  }
  if (parts[0] === "api" && parts[1] === "imports" && parts[2]) {
    const job = imports(app).get(parts[2]);
    if (!job) throw new HttpError(404, "Import not found");
    if (method === "POST" && parts[3] === "cancel") {
      await readJson(req);
      imports(app).cancel(job.id);
    }
    if (method === "POST" && ["resume", "retry"].includes(parts[3] ?? "")) {
      await readJson(req);
      imports(app).resume(job.id, parts[3] === "retry");
    }
    if (method === "DELETE") {
      await readJson(req);
      imports(app).remove(job.id);
      return { message: "Import removed." };
    }
    return { job };
  }
  if (method === "POST" && url.pathname === "/api/favorites") {
    const [track] = tracksFrom([(await readJson(req)).track]);
    if (!track) throw new HttpError(400, "No track to save");
    return {
      message: store.toggleFavorite(track) ? "Saved to favorites." : "Removed from favorites.",
    };
  }
  if (url.pathname === "/api/bots" && method === "POST") {
    return changeInstance(app, async () => {
      const body = await readJson(req);
      const name = validateBotName(str(body.name));
      if (app.bots.some((b) => b.name.toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, "An instance with that ID already exists");
      if (app.bots.length >= MAX_INSTANCES)
        throw new HttpError(400, `This server runs at most ${MAX_INSTANCES} instances`);
      const nickname = validateNickname(str(body.nickname) || name);
      if (body.platform !== undefined && !["teamspeak", "discord"].includes(str(body.platform)))
        throw new HttpError(400, "Unknown bot platform");
      if (body.platform === "discord") {
        if (!app.config.web.password)
          throw new HttpError(
            403,
            "Set a panel administrator password before storing Discord bot credentials",
          );
        const discord = validateDiscordConfig({
          token: str(body.token),
          guildId: str(body.guildId),
          channelId: str(body.channelId),
        });
        const cfg = {
          ...instanceConfig(app.config.bots[0]!, name),
          platform: "discord" as const,
          discord,
          nickname,
        };
        checkDiscordSlot(app, cfg);
        const credentials = discordInstances(app);
        credentials.set(name, discord);
        await credentials.flush();
        app.playlists.addPanelBot(name, nickname, discord.channelId, "discord");
        await app.playlists.flush();
        const bot = await createBot(app, cfg, app.bots.length);
        app.bots.push(bot);
        void bot
          .start()
          .catch((error) =>
            bot.log("error", error instanceof Error ? error.message : String(error)),
          );
        return { message: nickname + " is connecting to Discord.", bot: name };
      }
      // Every bot is on the same server, so a connected one can name the chosen channel.
      const channelId = str(body.channelId);
      const channel = channelId
        ? app.bots
            .filter((b) => b.platform === "teamspeak")
            .map((b) => b.channelPathById(channelId))
            .find(Boolean)
        : undefined;
      if (channelId && !channel) throw new HttpError(404, "Channel not found");
      app.playlists.addPanelBot(name, nickname, channel);
      const bot = await createBot(
        app,
        instanceConfig(
          app.config.bots.find((b) => b.platform !== "discord") ?? app.config.bots[0]!,
          name,
        ),
        app.bots.length,
      );
      app.bots.push(bot);
      bot
        .start()
        .catch((err: unknown) =>
          bot.log("error", `Bot failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      return {
        message: nickname + " is starting and joins TeamSpeak in a few seconds.",
        bot: name,
      };
    });
  }
  if (
    parts[0] === "api" &&
    parts[1] === "bots" &&
    parts[2] &&
    parts.length === 3 &&
    method === "DELETE"
  ) {
    return changeInstance(app, async () => {
      const bot = selectedBot(app, parts[2]);
      if (!panelManaged(app, bot.name))
        throw new HttpError(
          400,
          "This instance comes from the server configuration. Remove it there.",
        );
      await readJson(req);
      const nickname = bot.nickname;
      await bot.shutdown();
      app.bots.splice(app.bots.indexOf(bot), 1);
      app.playlists.removePanelBot(bot.name);
      await app.playlists.flush();
      if (bot.platform === "discord") {
        const credentials = discordInstances(app);
        credentials.remove(bot.name);
        await credentials.flush();
      }
      app.playback?.delete(bot.name);
      return { message: nickname + " was removed." };
    });
  }
  if (parts[1] === "bots" && parts[2] && parts[3] === "connection" && method === "POST") {
    return changeInstance(app, async () => {
      if (!app.config.web.password)
        throw new HttpError(
          403,
          "Set a panel administrator password before storing Discord bot credentials",
        );
      const bot = selectedBot(app, parts[2]);
      if (bot.platform !== "discord" || !panelManaged(app, bot.name))
        throw new HttpError(400, "Edit this instance in the server configuration");
      const body = await readJson(req),
        old = bot.cfg.discord;
      const discord = validateDiscordConfig({
        token: str(body.token) || old?.token || "",
        guildId: str(body.guildId) || old?.guildId || "",
        channelId: str(body.channelId) || bot.homeChannel,
      });
      const cfg = { ...bot.cfg, discord };
      checkDiscordSlot(app, cfg, bot.name);
      const credentials = discordInstances(app);
      credentials.set(bot.name, discord);
      await credentials.flush();
      const snapshot = bot.player.snapshot();
      await bot.shutdown();
      app.playlists.setChannel(bot.name, discord.channelId);
      await app.playlists.flush();
      const replacement = await createBot(app, cfg, bot.index);
      replacement.player.restore(snapshot);
      replacement.syncLibrary();
      app.bots[app.bots.indexOf(bot)] = replacement;
      void replacement
        .start()
        .catch((error) =>
          replacement.log("error", error instanceof Error ? error.message : String(error)),
        );
      return {
        message:
          "Discord connection settings saved. Reconnecting with your queue and position preserved.",
      };
    });
  }
  if (parts[0] === "api" && parts[1] === "bots" && parts[2] && parts[3] && method === "POST") {
    const result = await botAction(
      app,
      selectedBot(app, parts[2]),
      parts[3],
      await readJson(req),
      viewer,
    );
    return typeof result === "string" ? { message: plain(result) } : result;
  }
  if (parts[0] === "api" && parts[1] === "collections") {
    if (method === "POST" && parts.length === 2) {
      const collection = store.createCollection(str((await readJson(req)).name));
      return { message: "Collection created.", collection };
    }
    if (parts[2] && method === "PATCH") {
      store.renameCollection(parts[2], str((await readJson(req)).name));
      return { message: "Collection renamed." };
    }
    if (parts[2] && method === "DELETE") {
      store.deleteCollection(parts[2]);
      return { message: "Collection deleted. Its playlists are now standalone." };
    }
  }
  if (parts[0] === "api" && parts[1] === "radio-stations") {
    if (method === "POST" && parts.length === 2) {
      const body = await readJson(req);
      const station = store.createStation(str(body.name), streamUrl(body.url));
      return { message: station.name + " added to your stations.", station };
    }
    if (parts[2] && method === "PATCH") {
      const body = await readJson(req);
      store.updateStation(parts[2], str(body.name), streamUrl(body.url));
      return { message: "Radio station updated." };
    }
    if (parts[2] && method === "DELETE") {
      store.deleteStation(parts[2]);
      return { message: "Radio station deleted." };
    }
  }
  if (url.pathname === "/api/playlists" && method === "POST") {
    const body = await readJson(req);
    const list = store.create(str(body.name), str(body.collectionId) || null);
    return { message: "Created " + list.name, playlist: list };
  }
  if (parts[0] === "api" && parts[1] === "playlists" && parts[2]) {
    const list = store.find(parts[2]);
    if (!list) throw new HttpError(404, "No such playlist");
    if (method === "GET" && parts.length === 3) {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const limit = Math.min(
        100,
        Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 50)),
      );
      const matching = store.matchTracks(
          list,
          url.searchParams.get("q") ?? "",
          url.searchParams.get("duplicates") === "true",
        ),
        page = matching.slice(offset, offset + limit);
      return {
        ...list,
        tracks: page.map((t) => trackJson(t.track)),
        positions: page.map((t) => t.index),
        offset,
        total: matching.length,
        trackCount: list.tracks.length,
      };
    }
    if (method === "PATCH" && parts.length === 3) {
      const body = await readJson(req);
      store.update(
        list,
        str(body.name) || list.name,
        body.collectionId === undefined ? list.collectionId : str(body.collectionId) || null,
      );
      syncDefaults(app);
      return { message: "Playlist updated." };
    }
    if (method === "DELETE" && parts.length === 3) {
      store.delete(list);
      syncDefaults(app);
      return { message: "Deleted " + list.name };
    }
    if (method === "DELETE" && parts[3] === "tracks" && parts[4]) {
      const body = await readJson(req);
      if (body.expectedVersion !== undefined && body.expectedVersion !== list.version)
        throw new HttpError(409, "The playlist changed. Please try again.");
      checkOrder(list.tracks, body);
      const removed = store.removeTrack(list, Number(parts[4]));
      if (!removed) throw new HttpError(404, "No such song");
      syncDefaults(app);
      return { message: "Removed " + removed.title };
    }
    if (method === "POST" && parts[3]) {
      const body = await readJson(req);
      if (body.expectedVersion !== undefined && body.expectedVersion !== list.version)
        throw new HttpError(409, "The playlist changed. Please try again.");
      const bot = selectedBot(app, body.bot);
      switch (parts[3]) {
        case "bulk": {
          if (body.expectedVersion !== list.version)
            throw new HttpError(409, "The playlist changed. Refresh and select the tracks again.");
          const count = store.bulkTracks(list, body as Parameters<typeof store.bulkTracks>[1]);
          syncDefaults(app);
          return { message: `Updated ${count} track(s).` };
        }
        case "move":
          checkOrder(list.tracks, body);
          store.moveTrack(list, Number(body.from), Number(body.to));
          syncDefaults(app);
          return { message: "Playlist reordered." };
        case "add": {
          const input = str(body.input);
          let tracks = tracksFrom(body.tracks);
          if (input)
            tracks = (
              await resolve(app.config.ytdlpPath, input, {
                maxItems: app.config.maxPlaylistItems,
                wholePlaylist: true,
              })
            ).tracks;
          else if (body.current === true && bot.player.track) tracks = [bot.player.track];
          if (!tracks.length) throw new HttpError(400, "Nothing to add");
          // The asynchronous import may have outlived the playlist.
          if (!store.all.includes(list))
            throw new HttpError(409, "The playlist was deleted during import");
          store.addTracks(list, tracks);
          syncDefaults(app);
          return { message: "Added " + tracks.length + " track(s) to " + list.name };
        }
        case "play":
          if (!list.tracks.length) throw new HttpError(400, "Playlist is empty");
          return {
            message: plain(
              bot.enqueue(
                list.tracks.map((t) => ({ ...t, playlistId: list.id })),
                {
                  requestedBy: viewer.username,
                  requesterId: viewer.id,
                  privileged: viewer.role !== "listener",
                  playlistName: list.name,
                },
              ),
            ),
          };
        case "play-now":
          if (!list.tracks.length) throw new HttpError(400, "Playlist is empty");
          bot.player.playNow(
            list.tracks.map((t) => ({ ...t, requestedBy: "web", playlistId: list.id })),
            true,
          );
          return { message: "Playing " + list.name + " now. It replaced the queue." };
        case "save": {
          const tracks = [
            ...(bot.player.track && !bot.player.track.auto ? [bot.player.track] : []),
            ...bot.player.queue,
          ];
          if (!tracks.length) throw new HttpError(400, "The queue is empty");
          store.addTracks(list, tracks);
          syncDefaults(app);
          return { message: "Queue saved to " + list.name };
        }
      }
    }
  }
  throw new HttpError(404, "Not found");
}
