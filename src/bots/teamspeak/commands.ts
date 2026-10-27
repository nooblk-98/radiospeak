import {
  TextMessageTarget,
  sendChannelMessage,
  sendPrivateMessage,
  sendServerMessage,
  type TextMessageEvent,
} from "@honeybbq/teamspeak";
import type { Client } from "@honeybbq/teamspeak/client";
import type { App } from "../../app/context.ts";
import type { LoopMode, Track } from "../../audio/player.ts";
import { clampVolume } from "../../config/config.ts";
import { formatDuration, resolve } from "../../media/ytdlp.ts";
import type { MusicBot } from "../music-bot.ts";

const PAGE_SIZE = 10;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** TeamSpeak chat wraps links as [URL]...[/URL]; strip that. */
function cleanInput(s: string): string {
  return s
    .replace(/\[url(=[^\]]*)?\]/gi, "")
    .replace(/\[\/url\]/gi, "")
    .trim();
}

export function isAdmin(app: App, bot: MusicBot, msg: TextMessageEvent): boolean {
  if (app.playlists.chatAccess.enabled)
    return (
      bot.chatRole(
        msg.invokerUID,
        msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [],
      ) === "admin"
    );
  const { admins, adminGroups } = app.config;
  if (admins.length === 0 && adminGroups.length === 0) return true;
  if (admins.includes(msg.invokerUID)) return true;
  const groups = msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [];
  return groups.some((g) => adminGroups.includes(Number(g)));
}

function helpText(p: string): string {
  return [
    "[b]Music[/b]",
    `${p}play <YouTube/SoundCloud link, playlist or search> — add to queue   ${p}play — start/resume`,
    `${p}playall <link> — whole playlist from a song link   ${p}playnext <song> — play after this one`,
    `${p}search <words> — show 5 results, then ${p}pick <n>`,
    `${p}pause / ${p}resume   ${p}skip [n]   ${p}stop   ${p}np   ${p}vol [0-100]`,
    `${p}queue [page]   ${p}remove <n>   ${p}clear   ${p}shuffle   ${p}loop [off|one|all]`,
    "[b]Saved playlists[/b]",
    `${p}pl — list   ${p}pl new <name>   ${p}pl add <name> [link|search] (no link = current song)`,
    `${p}pl show <name>   ${p}pl play <name> [shuffle]   ${p}pl save <name> — save the queue   ${p}pl remove <name> <n>   ${p}pl delete <name>`,
    "[b]Other[/b]",
    `${p}radio <station|stream link|off> — live radio when the queue is empty   ${p}radio list   ${p}join — come to my channel   ${p}bots`,
  ].join("\n");
}

/** Posted in channel chat when someone joins the bot's channel. */
export function welcomeText(
  p: string,
  nickname: string,
  playing: string | undefined,
  role = "admin",
): string {
  return [
    `Welcome, [b]${nickname}[/b]! I'm the music bot.${playing ? ` Now playing: [b]${playing}[/b]` : ""}`,
    role === "listener"
      ? `${p}play <song, link or playlist> — request music   ${p}skip — vote to skip   ${p}np   ${p}queue   ${p}history`
      : `${p}play <song, link or playlist> — add to queue   ${p}skip   ${p}pause / ${p}resume   ${p}np   ${p}queue   ${p}vol <0-100>`,
    `${p}radio <station>   ${p}pl play <playlist>   ${p}join — bring me to your channel   ${p}help — all commands`,
  ].join("\n");
}

function trackLine(t: Track, n: number): string {
  return `${n}. ${t.title} (${formatDuration(t.duration)})${t.requestedBy ? ` — ${t.requestedBy}` : ""}`;
}

function page<T>(
  items: readonly T[],
  pageArg: string | undefined,
): { slice: T[]; pageNo: number; pages: number; offset: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, Number(pageArg) || 1));
  const offset = (pageNo - 1) * PAGE_SIZE;
  return { slice: items.slice(offset, offset + PAGE_SIZE), pageNo, pages, offset };
}

async function playlistCommand(
  app: App,
  bot: MusicBot,
  msg: TextMessageEvent,
  args: string[],
): Promise<string> {
  const p = app.config.commandPrefix;
  const [sub = "list", name = "", ...rest] = args;
  const store = app.playlists;
  const need = () => {
    const list = store.find(name);
    if (!list)
      throw new Error(
        name ? `No playlist "${name}". ${p}pl shows them.` : `Which playlist? ${p}pl shows them.`,
      );
    return list;
  };

  switch (sub.toLowerCase()) {
    case "list":
    case "ls":
      if (store.all.length === 0) return `No saved playlists yet. ${p}pl new <name>`;
      return `Saved playlists:\n${store.all.map((l, i) => `${i + 1}. [b]${l.name}[/b] — ${l.tracks.length} songs`).join("\n")}`;

    case "new":
    case "create": {
      const created = store.create([name, ...rest].join(" "));
      const reference = /\s/.test(created.name)
        ? String(store.all.indexOf(created) + 1)
        : created.name;
      return `Created playlist [b]${created.name}[/b]. Add songs with ${p}pl add ${reference} <link or search>`;
    }

    case "add": {
      const list = need();
      const input = cleanInput(rest.join(" "));
      let tracks: Track[];
      if (!input) {
        if (!bot.player.track) return "Nothing playing to add. Give a link or search words.";
        tracks = [bot.player.track];
      } else {
        tracks = (
          await resolve(app.config.ytdlpPath, input, { maxItems: app.config.maxPlaylistItems })
        ).tracks;
      }
      const total = store.addTracks(list, tracks);
      const what = tracks.length === 1 ? `[b]${tracks[0]!.title}[/b]` : `${tracks.length} songs`;
      return `Added ${what} to [b]${list.name}[/b] (${total} songs).`;
    }

    case "save": {
      const current = [
        ...(bot.player.track && !bot.player.track.auto ? [bot.player.track] : []),
        ...bot.player.queue,
      ];
      if (current.length === 0) return "The queue is empty.";
      const list = store.find(name) ?? store.create(name);
      const total = store.addTracks(list, current);
      return `Saved ${current.length} songs to [b]${list.name}[/b] (${total} songs).`;
    }

    case "show": {
      const list = need();
      if (list.tracks.length === 0) return `[b]${list.name}[/b] is empty.`;
      const pg = page(list.tracks, rest[0]);
      const lines = pg.slice.map((t, i) => trackLine(t, pg.offset + i + 1));
      return `[b]${list.name}[/b] — ${list.tracks.length} songs (page ${pg.pageNo}/${pg.pages})\n${lines.join("\n")}`;
    }

    case "play": {
      const list = need();
      if (list.tracks.length === 0) return `[b]${list.name}[/b] is empty.`;
      const tracks = list.tracks.map((t) => ({ ...t, playlistId: list.id }));
      if (rest[0]?.toLowerCase() === "shuffle") {
        for (let i = tracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
        }
      }
      return bot.enqueue(tracks, {
        requestedBy: msg.invokerName,
        requesterId: "ts:" + msg.invokerUID,
        privileged:
          bot.chatRole(
            msg.invokerUID,
            msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [],
          ) !== "listener",
        playlistName: list.name,
      });
    }

    case "remove":
    case "rm": {
      const list = need();
      const removed = store.removeTrack(list, Number(rest[0]));
      return removed
        ? `Removed [b]${removed.title}[/b] from ${list.name}.`
        : `Usage: ${p}pl remove <name> <song number>`;
    }

    case "delete":
    case "del": {
      if (
        !isAdmin(app, bot, msg) &&
        !(
          app.playlists.chatAccess.enabled &&
          bot.chatRole(
            msg.invokerUID,
            msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [],
          ) === "dj"
        )
      )
        return "Only bot admins or assigned DJs can delete playlists.";
      const list = need();
      store.delete(list);
      return `Deleted playlist [b]${list.name}[/b].`;
    }
  }
  return `Unknown playlist command. Type ${p}help`;
}

export async function runCommand(
  app: App,
  bot: MusicBot,
  msg: TextMessageEvent,
): Promise<string | undefined> {
  const before = app.playlists.revision,
    botBefore = bot.revision;
  const result = await executeCommand(app, bot, msg);
  if (app.operations && (before !== app.playlists.revision || botBefore !== bot.revision)) {
    const command = msg.message
      .trim()
      .slice(app.config.commandPrefix.length)
      .split(/\s+/)[0]
      ?.toLowerCase();
    if (command && /^[a-z-]{1,24}$/.test(command)) {
      app.operations.audit(
        "ts:" + msg.invokerUID,
        "TS",
        "/bots/" + encodeURIComponent(bot.name) + "/" + command,
      );
      await app.operations.flush();
    }
  }
  return result;
}

async function executeCommand(
  app: App,
  bot: MusicBot,
  msg: TextMessageEvent,
): Promise<string | undefined> {
  const p = app.config.commandPrefix;
  const text = msg.message.trim();
  if (!text.startsWith(p)) return undefined;
  const [rawCmd = "", ...args] = text.slice(p.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = cleanInput(args.join(" "));
  const player = bot.player;
  const role = bot.chatRole(
    msg.invokerUID,
    msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [],
  );
  const request = {
    requestedBy: msg.invokerName,
    requesterId: "ts:" + msg.invokerUID,
    privileged: role !== "listener",
  };
  if (role === "listener") {
    if (["skip", "next", "n"].includes(cmd)) {
      if (bot.channelID !== bot.client?.view.client(msg.invokerID)?.channelID)
        return "Join the music channel to vote.";
      return bot.voteSkip(request.requesterId);
    }
    const read =
      [
        "help",
        "h",
        "search",
        "find",
        "queue",
        "q",
        "list",
        "np",
        "status",
        "bots",
        "history",
      ].includes(cmd) ||
      (["vol", "volume", "v"].includes(cmd) && !arg) ||
      (cmd === "radio" && (!arg || arg.toLowerCase() === "list"));
    const enqueue = ["play", "p", "yt", "sc", "playall", "pa", "pick"].includes(cmd) && !!arg;
    const playlist =
      ["pl", "playlist", "playlists"].includes(cmd) &&
      ["list", "ls", "show", "play"].includes((args[0] || "list").toLowerCase());
    if (!read && !enqueue && !playlist && !["remove", "rm"].includes(cmd))
      return "A DJ manages playback and playlists. You can request songs or vote with !skip.";
  }

  switch (cmd) {
    case "help":
    case "h":
      return helpText(p);

    case "play":
    case "p":
    case "yt":
    case "sc": {
      if (!arg) {
        if (player.userPaused) {
          player.resume();
          return `Resumed.\n${bot.status()}`;
        }
        // Already playing (or loaded): say what, rather than "nothing to play".
        if (player.isActive || player.playIfIdle()) return bot.status();
        return `Nothing to play. ${p}play <song name or link>`;
      }
      return bot.play(arg, request);
    }

    case "playall":
    case "pa":
      if (!arg) return `Usage: ${p}playall <playlist link or a song link from a playlist>`;
      return bot.play(arg, { ...request, wholePlaylist: true });

    case "playnext":
    case "pn":
      if (!arg) return `Usage: ${p}playnext <song name or link>`;
      return bot.play(arg, { ...request, next: true });

    case "search":
    case "find": {
      if (!arg) return `Usage: ${p}search <words>`;
      const { tracks } = await resolve(app.config.ytdlpPath, arg, { maxItems: 5, results: 5 });
      app.searchResults.set(msg.invokerUID, tracks);
      if (app.searchResults.size > 1000)
        app.searchResults.delete(app.searchResults.keys().next().value!);
      return `Results (choose with ${p}pick <n>):\n${tracks.map((t, i) => trackLine(t, i + 1)).join("\n")}`;
    }

    case "pick": {
      const results = app.searchResults.get(msg.invokerUID);
      if (!results) return `Run ${p}search first.`;
      const chosen = args
        .map(Number)
        .map((n) => results[n - 1])
        .filter((t): t is Track => !!t);
      if (chosen.length === 0) return `Usage: ${p}pick <n> [n...] (1-${results.length})`;
      return bot.enqueue(chosen, request);
    }

    case "pause":
      if (!player.isActive) return "Nothing playing.";
      player.pause();
      return `Paused. ${p}resume to continue.`;

    case "resume":
    case "unpause":
      if (!player.userPaused) return player.playIfIdle() ? bot.status() : "Not paused.";
      player.resume();
      return "Resumed.";

    case "skip":
    case "next":
    case "n": {
      const count = Math.max(1, Number(args[0]) || 1);
      return player.skip(count)
        ? count > 1
          ? `Skipped ${count}.`
          : "Skipped."
        : "Nothing playing.";
    }

    case "stop":
      return bot.stop();

    case "clear":
      player.clearQueue();
      return "Queue cleared.";

    case "shuffle":
      if (player.queue.length < 2) return "Not enough songs in the queue to shuffle.";
      player.shuffle();
      return `Shuffled ${player.queue.length} songs.`;

    case "loop":
    case "repeat": {
      const order: LoopMode[] = ["off", "one", "all"];
      const wanted = args[0]?.toLowerCase() as LoopMode | undefined;
      const mode =
        wanted && order.includes(wanted)
          ? wanted
          : order[(order.indexOf(player.loop) + 1) % order.length]!;
      player.setLoop(mode);
      return `Loop: ${mode}`;
    }

    case "remove":
    case "rm": {
      if (
        role === "listener" &&
        player.queue[Number(args[0]) - 1]?.requesterId !== request.requesterId
      )
        return "You can only remove your own requests.";
      const removed = player.removeAt(Number(args[0]));
      return removed ? `Removed [b]${removed.title}[/b]` : `Usage: ${p}remove <queue number>`;
    }

    case "queue":
    case "q":
    case "list": {
      const lines = [bot.status()];
      if (player.queue.length) {
        const pg = page(player.queue, args[0]);
        lines.push(
          `Up next (page ${pg.pageNo}/${pg.pages}):`,
          ...pg.slice.map((t, i) => trackLine(t, pg.offset + i + 1)),
        );
      } else if (player.defaultPlaylist.size) {
        lines.push(
          `Queue empty — playing the default playlist${player.defaultPlaylist.name ? ` (${player.defaultPlaylist.name})` : ""}.`,
        );
      }
      return lines.join("\n");
    }

    case "np":
    case "status":
      return bot.status();
    case "history":
      return (
        app.playlists
          .historyFor(bot.name)
          .slice(0, 10)
          .map((h, i) => `${i + 1}. ${h.track.title}${h.error ? " (failed)" : ""}`)
          .join("\n") || "No playback history yet."
      );

    case "vol":
    case "volume":
    case "v": {
      if (!arg) return `Volume: ${player.volume}`;
      const v = Number(arg.replace(/%$/, ""));
      return Number.isFinite(v) ? bot.setVolume(clampVolume(v)) : `Usage: ${p}vol 0-100`;
    }

    case "radio": {
      if (!arg)
        return player.radio
          ? `Radio: ${player.radio.name}. ${p}radio off to stop it.`
          : `Usage: ${p}radio <station|stream link|off>`;
      if (arg.toLowerCase() === "off") return bot.playRadio(undefined);
      const stations = app.playlists.radioStations;
      if (arg.toLowerCase() === "list") {
        return stations.length
          ? "[b]Radio stations[/b]\n" + stations.map((r, i) => `${i + 1}. ${r.name}`).join("\n")
          : "No saved stations. Add them in the web panel.";
      }
      const station = app.playlists.findStation(arg);
      return station ? bot.playRadio(station.url, station.name) : bot.playRadio(arg);
    }

    case "pl":
    case "playlist":
    case "playlists":
      return playlistCommand(app, bot, msg, args);

    case "join":
    case "come": {
      const target = bot.client?.view.client(msg.invokerID)?.channelID;
      if (target === undefined) return "I can't see which channel you are in.";
      if (target === bot.channelID) return "I'm already here.";
      await bot.moveTo(target);
      return undefined; // the reply would go to the old channel
    }

    case "bots":
      return app.bots
        .map(
          (b) =>
            `[b]${b.name}[/b] — ${b.connected ? `#${b.channelName ?? "?"}` : "offline"} — ${b.status()}`,
        )
        .join("\n");

    default:
      return `Unknown command. Type ${p}help`;
  }
}

/** TeamSpeak rejects text messages over 1024 bytes; split long replies on line breaks. */
const MAX_MESSAGE_BYTES = 900;

function chunkLines(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (current && Buffer.byteLength(next) > MAX_MESSAGE_BYTES) {
      chunks.push(current);
      current = line;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function reply(c: Client, msg: TextMessageEvent, text: string): Promise<void> {
  for (const chunk of chunkLines(text)) {
    if (msg.targetMode === TextMessageTarget.Client)
      await sendPrivateMessage(c, msg.invokerID, chunk);
    else if (msg.targetMode === TextMessageTarget.Server) await sendServerMessage(c, chunk);
    else await sendChannelMessage(c, chunk);
  }
}

export async function handleChatMessage(
  app: App,
  bot: MusicBot,
  c: Client,
  msg: TextMessageEvent,
): Promise<void> {
  let answer: string | undefined;
  try {
    answer = await runCommand(app, bot, msg);
    await app.playlists.flush();
    if (answer === undefined && !msg.message.trim().startsWith(app.config.commandPrefix)) return;
    bot.log("info", `${msg.invokerName}: ${msg.message}`);
  } catch (err) {
    answer = `Error: ${errText(err)}`;
    bot.log("warn", `Command "${msg.message}" failed: ${errText(err)}`);
  }
  if (answer)
    await reply(c, msg, answer).catch((err: unknown) =>
      bot.log("warn", `Reply failed: ${errText(err)}`),
    );
}
