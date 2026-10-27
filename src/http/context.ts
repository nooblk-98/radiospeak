/** Shared request context; instance changes are serialized per application. */
import { type App } from "../app/context.ts";
import { MusicBot } from "../bots/music-bot.ts";
import { ImportManager } from "../library/imports.ts";

import { HttpError, str } from "./helpers.ts";

export function imports(app: App) {
  return (app.imports ??= new ImportManager(
    app.playlists,
    app.config.ytdlpPath,
    app.config.maxPlaylistItems,
  ));
}
/** Each instance runs its own audio pipeline, so panel-created ones are capped. */
export const MAX_INSTANCES = 10;
export const panelManaged = (app: App, name: string) =>
  app.playlists.panelBots.includes(name) &&
  !app.config.bots.some((bot) => bot.name.toLowerCase() === name.toLowerCase());
const instanceChanges = new WeakMap<App, Promise<void>>();
export async function changeInstance<T>(app: App, change: () => Promise<T>): Promise<T> {
  const previous = instanceChanges.get(app);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  instanceChanges.set(app, current);
  if (previous) await previous;
  try {
    return await change();
  } finally {
    release();
    if (instanceChanges.get(app) === current) instanceChanges.delete(app);
  }
}
export function syncDefaults(app: App): void {
  for (const bot of app.bots) bot.syncLibrary();
}
export function selectedBot(app: App, value: unknown): MusicBot {
  const bot = value ? app.bots.find((b) => b.name === str(value)) : app.bots[0];
  if (!bot) throw new HttpError(404, "No such bot");
  return bot;
}
