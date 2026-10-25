import {
  TextMessageTarget,
  sendChannelMessage,
  sendPrivateMessage,
  sendServerMessage,
  type TextMessageEvent,
} from "@honeybbq/teamspeak";
import type { Client } from "@honeybbq/teamspeak/client";
import type { App, RadioBot } from "./bot.ts";
import { clampVolume, type Station } from "./config.ts";
import { searchStations } from "./radiobrowser.ts";
import { ScheduleStore } from "./store.ts";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** TeamSpeak chat wraps links as [URL]...[/URL]; strip that. */
function cleanUrl(s: string | undefined): string | undefined {
  return s?.replace(/^\[url(=[^\]]*)?\]/i, "").replace(/\[\/url\]$/i, "");
}

const isUrl = (s: string | undefined): s is string => !!s && /^https?:\/\//i.test(s);

export function isAdmin(app: App, bot: RadioBot, msg: TextMessageEvent): boolean {
  const { admins, adminGroups } = app.config;
  if (admins.length === 0 && adminGroups.length === 0) return true;
  if (admins.includes(msg.invokerUID)) return true;
  const groups = msg.invokerGroups ?? bot.client?.view.client(msg.invokerID)?.serverGroups ?? [];
  return groups.some((g) => adminGroups.includes(Number(g)));
}

function helpText(p: string): string {
  return [
    "[b]Radio[/b]",
    `${p}list — stations   ${p}play [n|id|name] — play / resume   ${p}stop`,
    `${p}next / ${p}prev — switch station   ${p}vol [0-100]   ${p}np — now playing`,
    `${p}search <name|country|genre> — find stations online, then ${p}add <n>`,
    "[b]YouTube / SoundCloud[/b]",
    `${p}yt <link or search> — play a track, radio resumes after   ${p}skip   ${p}queue   ${p}clear`,
    "[b]Bot[/b]",
    `${p}join — move the bot to your channel   ${p}bots — list bots`,
    "[b]Admin[/b]",
    `${p}add <n> | ${p}add <id> <url> [name] — add station   ${p}remove <id>   ${p}backup <id> <url>`,
    `${p}schedule — list   ${p}schedule add 08:00 <station|stop> [mon,tue..] [vol=40]   ${p}schedule remove <n>`,
  ].join("\n");
}

function listText(app: App, bot: RadioBot): string {
  const list = app.stations.items;
  if (list.length === 0) return `No stations yet. Use ${app.config.commandPrefix}search or ${app.config.commandPrefix}add`;
  const current = bot.radio.station?.id;
  return (
    "Stations:\n" +
    list.map((s, i) => `${i + 1}. [b]${s.name}[/b] (${s.id})${s.id === current ? "  ◀ playing" : ""}`).join("\n")
  );
}

export async function runCommand(app: App, bot: RadioBot, msg: TextMessageEvent): Promise<string | undefined> {
  const p = app.config.commandPrefix;
  const text = msg.message.trim();
  if (!text.startsWith(p)) return undefined;
  const [rawCmd = "", ...args] = text.slice(p.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = args.join(" ");
  const admin = () => isAdmin(app, bot, msg);
  const denied = "Only radio admins can do that.";

  switch (cmd) {
    case "help":
    case "h":
      return helpText(p);

    case "list":
    case "stations":
    case "ls":
      return listText(app, bot);

    case "play":
    case "p": {
      if (!arg) {
        if (bot.radio.station) return bot.playStation(bot.radio.station);
        const station = app.stations.find(bot.cfg.defaultStation) ?? app.stations.items[0];
        return station ? bot.playStation(station) : "No stations configured.";
      }
      const station = app.stations.find(arg);
      return station ? bot.playStation(station) : `Unknown station "${arg}". Use ${p}list or ${p}search.`;
    }

    case "stop":
      return bot.stop();

    case "next":
    case "n":
      return bot.switchStation(1);

    case "prev":
    case "previous":
      return bot.switchStation(-1);

    case "vol":
    case "volume":
    case "v": {
      if (!arg) return `Volume: ${bot.radio.volume}`;
      const v = Number(arg.replace(/%$/, ""));
      return Number.isFinite(v) ? bot.setVolume(clampVolume(v)) : `Usage: ${p}vol 0-100`;
    }

    case "np":
    case "status":
      return bot.status();

    case "search":
    case "find": {
      if (!arg) return `Usage: ${p}search <station name, country or genre>`;
      const results = await searchStations(arg, 10);
      if (results.length === 0) return `Nothing found for "${arg}".`;
      app.searchResults.set(msg.invokerUID, results);
      const lines = results.map(
        (s, i) => `${i + 1}. [b]${s.name}[/b] — ${s.country || "?"}, ${s.codec || "?"} ${s.bitrate ? `${s.bitrate}k` : ""}`,
      );
      return `Results for "${arg}" (add with ${p}add <n>):\n${lines.join("\n")}`;
    }

    case "add": {
      if (!admin()) return denied;
      let station: Station;
      const n = Number(args[0]);
      if (args.length === 1 && Number.isInteger(n)) {
        const found = app.searchResults.get(msg.invokerUID)?.[n - 1];
        if (!found) return `No search result #${n}. Run ${p}search first.`;
        station = { id: app.stations.uniqueId(found.name), name: found.name, url: found.url };
      } else if (isUrl(cleanUrl(args[0]))) {
        const name = args.slice(1).join(" ") || new URL(cleanUrl(args[0])!).hostname;
        station = { id: app.stations.uniqueId(name), name, url: cleanUrl(args[0])! };
      } else {
        const [id, rawUrl, ...nameParts] = args;
        const url = cleanUrl(rawUrl);
        if (!id || !isUrl(url)) return `Usage: ${p}add <search #> | ${p}add <id> <url> [name] | ${p}add <url> [name]`;
        station = { id, name: nameParts.join(" ") || id, url };
      }
      app.stations.add(station);
      return `Added ${app.stations.items.length}. [b]${station.name}[/b] (${station.id}) — ${p}play ${station.id}`;
    }

    case "remove":
    case "rm":
    case "delete": {
      if (!admin()) return denied;
      const station = app.stations.find(arg);
      if (!station) return `Unknown station "${arg}".`;
      app.stations.remove(station.id);
      for (const b of app.bots) if (b.radio.station?.id === station.id) b.radio.stop();
      return `Removed [b]${station.name}[/b]`;
    }

    case "backup": {
      if (!admin()) return denied;
      const station = app.stations.find(args[0] ?? "");
      const url = cleanUrl(args[1]);
      if (!station || !isUrl(url)) return `Usage: ${p}backup <station> <url>`;
      app.stations.remove(station.id);
      const updated = { ...station, backupUrls: [...(station.backupUrls ?? []), url] };
      app.stations.add(updated);
      return `[b]${station.name}[/b] now has ${updated.backupUrls.length} backup URL(s).`;
    }

    case "yt":
    case "youtube":
    case "sc":
    case "soundcloud":
    case "song":
    case "track": {
      if (!arg) return `Usage: ${p}yt <YouTube/SoundCloud link or search words>`;
      return bot.enqueue(cleanUrl(arg) ?? arg, msg.invokerName);
    }

    case "skip":
      return bot.radio.skip() ? "Skipped." : "No track playing.";

    case "queue":
    case "q": {
      const r = bot.radio;
      if (!r.track && r.queue.length === 0) return "Queue is empty.";
      const lines = r.queue.map((t, i) => `${i + 1}. ${t.title}${t.requestedBy ? ` (${t.requestedBy})` : ""}`);
      return [`Now: ${r.track ? `[b]${r.track.title}[/b]` : "radio"}`, ...lines].join("\n");
    }

    case "clear":
      bot.radio.clearQueue();
      return "Queue cleared.";

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
        .map((b) => `[b]${b.name}[/b] — ${b.connected ? `#${b.channelName ?? "?"}` : "offline"} — ${b.status()}`)
        .join("\n");

    case "schedule":
    case "sched": {
      const sub = args[0]?.toLowerCase();
      if (!sub || sub === "list") {
        const items = app.schedule.items;
        if (items.length === 0) return `No schedule. ${p}schedule add 08:00 <station|stop> [mon,tue] [vol=40]`;
        return `Schedule (${app.config.timezone}):\n${items.map((e, i) => `${i + 1}. ${ScheduleStore.describe(e)}`).join("\n")}`;
      }
      if (!admin()) return denied;
      if (sub === "remove" || sub === "rm") {
        const removed = app.schedule.removeAt(Number(args[1]));
        return removed ? `Removed: ${ScheduleStore.describe(removed)}` : "No such schedule entry.";
      }
      if (sub === "add") {
        const [, time, target, ...rest] = args;
        if (!time || !target) return `Usage: ${p}schedule add 08:00 <station|stop> [mon,tue] [vol=40] [bot=name]`;
        const stationId = target.toLowerCase() === "stop" ? "stop" : app.stations.find(target)?.id;
        if (!stationId) return `Unknown station "${target}".`;
        const entry: Parameters<ScheduleStore["add"]>[0] = { time, station: stationId };
        for (const r of rest) {
          const [k, v = ""] = r.includes("=") ? r.split("=", 2) : ["days", r];
          if (k === "vol" || k === "volume") entry.volume = clampVolume(Number(v));
          else if (k === "bot") entry.bot = v;
          else entry.days = v.split(",");
        }
        return `Added: ${ScheduleStore.describe(app.schedule.add(entry))}`;
      }
      return `Usage: ${p}schedule [list|add|remove]`;
    }

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
    if (msg.targetMode === TextMessageTarget.Client) await sendPrivateMessage(c, msg.invokerID, chunk);
    else if (msg.targetMode === TextMessageTarget.Server) await sendServerMessage(c, chunk);
    else await sendChannelMessage(c, chunk);
  }
}

export async function handleChatMessage(app: App, bot: RadioBot, c: Client, msg: TextMessageEvent): Promise<void> {
  let answer: string | undefined;
  try {
    answer = await runCommand(app, bot, msg);
    if (answer === undefined && !msg.message.trim().startsWith(app.config.commandPrefix)) return;
    bot.log("info", `${msg.invokerName}: ${msg.message}`);
  } catch (err) {
    answer = `Error: ${errText(err)}`;
    bot.log("warn", `Command "${msg.message}" failed: ${errText(err)}`);
  }
  if (answer) await reply(c, msg, answer).catch((err: unknown) => bot.log("warn", `Reply failed: ${errText(err)}`));
}
