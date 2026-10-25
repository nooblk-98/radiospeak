import { log, type App } from "./bot.ts";
import { ScheduleStore } from "./store.ts";

function localNow(timezone: string): { date: string; time: string; day: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    day: String(parts.weekday).toLowerCase().slice(0, 3),
  };
}

/** Fires schedule.json entries at their minute, once per day each. */
export function startScheduler(app: App): void {
  const fired = new Set<string>();

  const check = () => {
    const now = localNow(app.config.timezone);
    app.schedule.items.forEach((entry, i) => {
      if (entry.time !== now.time) return;
      if (entry.days?.length && !entry.days.includes(now.day)) return;
      const key = `${now.date} ${i} ${ScheduleStore.describe(entry)}`;
      if (fired.has(key)) return;
      fired.add(key);

      const bots = entry.bot ? app.bots.filter((b) => b.name === entry.bot) : app.bots;
      for (const bot of bots) {
        if (entry.volume !== undefined) bot.setVolume(entry.volume);
        if (entry.station === "stop") {
          bot.stop();
        } else {
          const station = app.stations.find(entry.station);
          if (!station) {
            bot.log("warn", `Schedule: unknown station "${entry.station}"`);
            continue;
          }
          bot.playStation(station);
        }
        bot.log("info", `Schedule: ${ScheduleStore.describe(entry)}`);
      }
    });
    for (const key of fired) if (!key.startsWith(now.date)) fired.delete(key);
  };

  setInterval(check, 15_000).unref();
  log("info", `Scheduler running (${app.config.timezone}, ${app.schedule.items.length} entries)`);
}
