/** Player mutations and short-lived queue undo state, shared by the HTTP router. */
import { randomUUID } from "node:crypto";
import { type App } from "../app/context.ts";
import type { LoopMode, Track } from "../audio/player.ts";
import { MusicBot } from "../bots/music-bot.ts";
import { clampVolume } from "../config/config.ts";
import { settingsFrom, type Viewer } from "../domain/policies.ts";
import { trackKey } from "../domain/track-key.ts";

import { syncDefaults } from "./context.ts";
import { checkOrder, HttpError, httpUrl, plain, str, tracksFrom } from "./helpers.ts";

const undo = new WeakMap<
  MusicBot,
  {
    token: string;
    track: Track;
    position: number;
    expires: number;
    order: string;
    current: string | undefined;
  }
>();
export async function botAction(
  app: App,
  bot: MusicBot,
  action: string,
  body: Record<string, unknown>,
  viewer: Viewer,
): Promise<string | { message: string; undoToken?: string; added?: number }> {
  const pl = bot.player;
  switch (action) {
    case "play": {
      const input = str(body.input);
      if (!input) throw new HttpError(400, "Enter a link or search words");
      if (viewer.role === "listener" && body.next)
        throw new HttpError(403, "A DJ can choose what plays next");
      return bot.play(input, {
        requestedBy: viewer.username,
        requesterId: viewer.id,
        privileged: viewer.role !== "listener",
        next: body.next === true,
        wholePlaylist: body.all === true,
      });
    }
    case "enqueue":
    case "play-now": {
      let tracks = tracksFrom(body.tracks);
      if (!tracks.length) throw new HttpError(400, "No playable tracks");
      if (action === "play-now") {
        pl.playNow(tracks.map((t) => ({ ...t, requestedBy: "web" })));
        return "Playing now.";
      }
      if (viewer.role === "listener" && body.next)
        throw new HttpError(403, "A DJ can choose what plays next");
      if (body.unique === true) {
        const seen = new Set(
          [...(pl.track ? [pl.track] : []), ...pl.queue].map((t) => trackKey(t.url)),
        );
        tracks = tracks.filter((track) => {
          const key = trackKey(track.url);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!tracks.length) return { message: "Already playing or queued.", added: 0 };
      }
      const message = bot.enqueue(tracks, {
        requestedBy: viewer.username,
        requesterId: viewer.id,
        privileged: viewer.role !== "listener",
        next: body.next === true,
      });
      return body.unique === true ? { message: plain(message), added: tracks.length } : message;
    }
    case "start":
      return pl.playIfIdle() ? "Playing." : "Nothing to play.";
    case "vote-skip":
      return bot.voteSkip(viewer.id);
    case "settings": {
      const value = body.settings as Parameters<typeof settingsFrom>[0];
      if (!value || typeof value !== "object") throw new HttpError(400, "Settings are required");
      app.playlists.setSettings(bot.name, value);
      bot.syncLibrary();
      return "Bot performance and request settings saved.";
    }
    case "pause":
      pl.pause();
      return "Paused.";
    case "resume":
      pl.resume();
      return "Resumed.";
    case "skip":
      return pl.skip(Math.max(1, Number(body.count) || 1)) ? "Skipped." : "Nothing playing.";
    case "previous":
      return pl.previous() ? "Previous track." : "No previous track.";
    case "stop":
      return bot.stop();
    case "clear":
      checkOrder(pl.queue, body);
      pl.clearQueue();
      return "Queue cleared.";
    case "shuffle":
      pl.setShuffle(body.enabled !== false);
      return body.enabled === false ? "Shuffle off." : "Shuffle on.";
    case "loop": {
      const mode = str(body.mode) as LoopMode;
      if (!["off", "one", "all"].includes(mode))
        throw new HttpError(400, "Loop must be off, one or all");
      pl.setLoop(mode);
      return "Repeat: " + mode;
    }
    case "volume": {
      if (!Number.isFinite(body.volume)) throw new HttpError(400, "Volume must be a number");
      return bot.setVolume(clampVolume(Number(body.volume)));
    }
    case "seek":
      if (body.url !== pl.track?.url)
        throw new HttpError(409, "The track changed. Please try again.");
      if (!pl.seek(Number(body.seconds))) throw new HttpError(400, "This track cannot be seeked");
      return "Playback position updated.";
    case "normalization":
      pl.setNormalization(body.enabled === true);
      return "Audio normalization updated.";
    case "prebuffer":
      pl.setPrebuffer(body.enabled === true);
      return "Next-track prebuffering " + (body.enabled ? "enabled." : "disabled.");
    case "delete-current": {
      // The panel names the song it means, so a song that just changed is never deleted by mistake.
      const track = pl.track;
      if (!track || track.url !== str(body.url))
        throw new HttpError(409, "The song changed. Please try again.");
      const list = bot.playlistOf(track);
      if (!list)
        throw new HttpError(400, "This song isn't from a saved playlist. Skip it instead.");
      const removed = app.playlists.removeSong(list, track.url);
      syncDefaults(app);
      // Upcoming copies queued from the same playlist go too.
      const key = trackKey(track.url);
      for (let i = pl.queue.length; i >= 1; i--) {
        const queued = pl.queue[i - 1]!;
        if (queued.playlistId === list.id && trackKey(queued.url) === key) pl.removeAt(i);
      }
      pl.skip();
      return (
        "Deleted " +
        track.title +
        " from " +
        list.name +
        (removed > 1 ? " (" + removed + " copies)" : "") +
        "."
      );
    }
    case "welcome":
      app.playlists.setWelcomes(bot.name, body.enabled === true);
      return body.enabled === true
        ? "New listeners get the command list in channel chat."
        : "Join greetings turned off.";
    case "nickname":
      await bot.setNickname(str(body.nickname));
      return "Bot name saved.";
    case "remove": {
      checkOrder(pl.queue, body);
      if (
        viewer.role === "listener" &&
        pl.queue[Number(body.position) - 1]?.requesterId !== viewer.id
      )
        throw new HttpError(403, "You can only remove your own requests");
      const removed = pl.removeAt(Number(body.position));
      if (!removed) throw new HttpError(404, "No such queue position");
      const token = randomUUID();
      undo.set(bot, {
        token,
        track: removed,
        position: Number(body.position),
        expires: Date.now() + 60_000,
        order: JSON.stringify(pl.queue.map((t) => t.url)),
        current: pl.track?.url,
      });
      return { message: "Removed " + removed.title, undoToken: token };
    }
    case "undo": {
      const saved = undo.get(bot);
      if (!saved || saved.token !== body.token || saved.expires < Date.now())
        throw new HttpError(409, "Undo expired");
      if (viewer.role === "listener" && saved.track.requesterId !== viewer.id)
        throw new HttpError(403, "This was another listener's request");
      if (
        saved.order !== JSON.stringify(pl.queue.map((t) => t.url)) ||
        saved.current !== pl.track?.url
      )
        throw new HttpError(409, "The queue changed. Undo is no longer available.");
      if (!pl.insertAt(saved.track, saved.position))
        throw new HttpError(409, "Cannot restore this position");
      undo.delete(bot);
      return "Track restored to the queue.";
    }
    case "move": {
      checkOrder(pl.queue, body);
      if (!pl.moveAt(Number(body.from), Number(body.to)))
        throw new HttpError(400, "Invalid queue positions");
      return "Queue reordered.";
    }
    case "channel": {
      if (!bot.connected) throw new HttpError(400, "Connect the bot before switching channels");
      const channel = bot.channels.find((c) => c.id === str(body.channelId));
      if (!channel) throw new HttpError(404, "Channel not found");
      await bot.moveToChannel(channel.id, true);
      return "Moved to " + channel.name + ". The bot returns here after reconnecting.";
    }
    case "default": {
      const list = body.playlistId === null ? null : app.playlists.find(str(body.playlistId));
      if (list === undefined) throw new HttpError(404, "Playlist not found");
      app.playlists.setDefault(bot.name, list);
      syncDefaults(app);
      return list ? list.name + " is now the default idle playlist." : "Idle playlist disabled.";
    }
    case "radio": {
      if (body.stationId !== undefined) {
        const station = app.playlists.radioStations.find((r) => r.id === str(body.stationId));
        if (!station) throw new HttpError(404, "Radio station not found");
        return bot.playRadio(station.url, station.name);
      }
      const url = str(body.url);
      if (url && !httpUrl(url)) throw new HttpError(400, "Enter a valid HTTP or HTTPS stream URL");
      return bot.playRadio(url || undefined);
    }
  }
  throw new HttpError(404, "Unknown action");
}
