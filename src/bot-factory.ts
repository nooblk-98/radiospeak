import { MusicBot, type App } from "./bot.ts";
import { DiscordInstances } from "./discord-instances.ts";
import { instanceConfig, type BotConfig } from "./config.ts";

export function discordInstances(app: App) {return app.discordInstances ??= new DiscordInstances(app.playlists.path);}
export function checkDiscordSlot(app: App,cfg: BotConfig,except?:string) {
  if(cfg.platform!=="discord" || !cfg.discord?.token)return;
  const fingerprint=DiscordInstances.fingerprint(cfg.discord.token);
  if(app.bots.some(bot=>bot.name!==except && bot.platform==="discord" && bot.cfg.discord?.guildId===cfg.discord!.guildId && DiscordInstances.fingerprint(bot.cfg.discord.token)===fingerprint))throw new Error("This Discord bot already has an instance in that server. One bot account can join one voice channel per server; use another bot token for a second channel.");
}
export async function createBot(app: App,cfg: BotConfig,index: number):Promise<MusicBot> {
  checkDiscordSlot(app,cfg,cfg.name);
  if(cfg.platform!=="discord")return new MusicBot(app,cfg,index);
  // TeamSpeak-only installs do not load the Discord gateway or native voice stack.
  const {DiscordMusicBot}=await import("./discord-bot.ts");return new DiscordMusicBot(app,cfg,index);
}
export function panelBotConfig(app: App,name: string):BotConfig {
  const template=app.config.bots.find(cfg=>cfg.platform!=="discord") ?? app.config.bots[0]!;
  const cfg=instanceConfig(template,name);
  if(app.playlists.platformFor(name)==="discord")return {...cfg,platform:"discord",discord:discordInstances(app).get(name)};
  return cfg;
}
