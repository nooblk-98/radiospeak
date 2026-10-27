/** Shared application contract. Type-only dependencies keep service initialization explicit. */
import type { Track } from "../audio/player.ts";
import type { DiscordInstances } from "../bots/discord/credentials.ts";
import type { MusicBot } from "../bots/music-bot.ts";
import type { AppConfig } from "../config/config.ts";
import type { ImportManager } from "../library/imports.ts";
import type { PlaylistStore } from "../library/store.ts";
import type { Operations } from "../operations/audit-store.ts";
import type { PlaybackStore } from "../persistence/playback-store.ts";

/** What every bot shares: config, saved playlists and each other. */
export interface App {
  config: AppConfig;
  playlists: PlaylistStore;
  playback?: PlaybackStore;
  imports?: ImportManager;
  operations?: Operations;
  discordInstances?: DiscordInstances;
  bots: MusicBot[];
  /** Last !search results per user unique ID, so "!pick 3" can choose one. */
  searchResults: Map<string, Track[]>;
}
