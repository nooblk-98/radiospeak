/** Per-application Discord gateway leases; the last instance releases the connection. */
import { Client, GatewayIntentBits } from "discord.js";
import type { App } from "../../app/context.ts";
import { DiscordInstances } from "./credentials.ts";

interface SharedClient {
  client: Client;
  ready: Promise<unknown>;
  users: number;
}
const pools = new WeakMap<App, Map<string, SharedClient>>();

/** One gateway session per token; different server instances share it safely. */
export function acquireDiscordClient(app: App, token: string) {
  let pool = pools.get(app);
  if (!pool) {
    pool = new Map();
    pools.set(app, pool);
  }
  const key = DiscordInstances.fingerprint(token);
  let shared = pool.get(key);
  if (!shared) {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      allowedMentions: { parse: [] },
      rest: { timeout: 15000 },
    });
    client.setMaxListeners(64); // Gateway/voice handlers for up to ten server instances.
    client.on("error", () => {}); // Each instance reports a sanitized connection error.
    shared = { client, ready: Promise.resolve().then(() => client.login(token)), users: 0 };
    void shared.ready.catch(() => {});
    pool.set(key, shared);
  }
  shared.users++;
  const record = shared;
  let released = false;
  return {
    client: record.client,
    ready: record.ready,
    async release() {
      if (released) return;
      released = true;
      if (--record.users === 0) {
        pool!.delete(key);
        await record.client.destroy();
      }
    },
  };
}

export function discordError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/TokenInvalid|invalid token|incorrect login/i.test(raw))
    return "Discord rejected the bot token. Update it in the instance connection settings.";
  return (token ? raw.split(token).join("[redacted]") : raw)
    .replace(/Bot\s+[A-Za-z0-9_.-]{20,}/g, "Bot [redacted]")
    .slice(0, 400);
}
