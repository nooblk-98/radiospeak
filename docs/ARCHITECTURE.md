# Codebase architecture

radiospeak runs directly from TypeScript in one Node.js process. The browser uses native ES modules and plain CSS. There is no bundler, frontend framework, database server or generated source directory.

## Source map

```text
src/
|-- index.ts                 Process entry point and graceful shutdown
|-- app/context.ts           Shared application contracts (type imports only)
|-- audio/                   Queue, playback, gain, Opus framing and shuffle
|-- bots/
|   |-- factory.ts           Platform selection and instance validation
|   |-- music-bot.ts         Shared bot behavior and default TeamSpeak transport
|   |-- teamspeak/           TeamSpeak chat commands
|   `-- discord/             Discord voice, slash commands, gateway and credentials
|-- config/                  Configuration parsing and validation
|-- domain/                  Request policies, roles, schedules and track identity
|-- http/                    Server, routes, actions, validation and public state
|-- library/                 Saved library and resumable playlist imports
|-- media/                   yt-dlp, lookup concurrency and radio metadata
|-- operations/              Bounded, durable audit journal
|-- persistence/             Atomic writes and playback checkpoints
|-- security/                Accounts and panel authentication
|-- shared/                  Logging and deterministic source revision
`-- web/
    |-- app.js               Browser state, navigation and delegated events
    |-- index.html           Panel shell
    |-- login.html           Standalone login page
    |-- styles.css           Ordered CSS entry point
    |-- assets/              Platform logos
    |-- features/            Notification, enqueue and volume controllers
    |-- state/               API requests, SSE and polling fallback
    |-- styles/              Base, component, feature and responsive CSS layers
    |-- ui/                  Stateless formatting, icons, artwork and components
    `-- views/               Dashboard, library, search, radio, player and settings
```

`scripts/` contains deployment checks and isolated audio diagnostics. `tests/` contains the unit, HTTP, DOM and real-audio regression suites. Tests use temporary stores and fake platform connections.

## Startup and platform boundaries

`index.ts` loads configuration and persistent stores, creates configured and panel-managed instances through `bots/factory.ts`, starts the optional HTTP server, and staggers bot connections. Shutdown stops the bots and flushes imports, credentials, the library and audit journal.

`MusicBot` owns common request handling, library synchronization, history, listener policies and checkpoint integration. Its existing default transport is TeamSpeak. `DiscordMusicBot` extends the same lifecycle through protected transport hooks. This deliberately retains the existing inheritance contract; changing transports must not replace a player's queue or checkpoint.

The factory imports the Discord implementation lazily. TeamSpeak-only installs therefore do not initialize the Discord SDK or its voice dependencies. Discord gateway sessions are shared by token within one application, and the last released instance closes the session. Tokens are encrypted by the credential store and excluded from panel snapshots, portable exports and audit payloads.

## Audio and media

`audio/player.ts` is the playback state machine. It chooses user requests before idle playlists or radio, manages pause/resume and recovery, and streams 20 ms Opus frames through a platform callback. FFmpeg owns decoding and encoding; gain changes and backpressure are handled by `audio/audio-gain.ts`. Optional prebuffering prepares only an eligible next track and discards stale work.

`media/ytdlp.ts` handles provider lookup, search caching and cancellation. Its task pool bounds subprocess concurrency. `library/imports.ts` persists import cursors and track batches so interruption does not restart a large playlist from the beginning. Keep lookup, import and playback cancellation separate: cancelling one search consumer must not cancel another consumer's shared lookup.

## HTTP boundaries

| Module              | Responsibility                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `server.ts`         | HTTP lifecycle, authentication, health, SSE, durable mutation responses and audit flushing |
| `routes.ts`         | API dispatch, role checks and library/instance operations                                  |
| `player-actions.ts` | Playback mutations, queue operations and expiring Undo                                     |
| `helpers.ts`        | JSON limits, input validation, stale-order checks and public track data                    |
| `context.ts`        | Shared service access, bot selection and serialized instance changes                       |
| `state.ts`          | Safe snapshots and cached playlist summaries                                               |
| `assets.ts`         | Browser files, compatibility URLs, CSS assembly and revision stamping                      |

The panel receives full structural state when a revision changes and lightweight `playback_progress` events otherwise. Broadcast frames are serialized once for all connected viewers. Authentication is rechecked for open streams. Playlist tracks remain paginated, and stale positional edits fail before mutating a different track.

## Browser boundaries

`web/app.js` coordinates mutable panel state and user events. View factories receive a `getContext` callback and read it for each render, so they always use the latest SSE snapshot, selected bot and filters. Shared `ui/` modules format escaped markup without owning application state. Feature controllers serialize rapid volume changes, guard duplicate enqueue requests and manage the notification bell independently of view rendering.

The server serves nested module paths and retains the previous root asset URLs, including `/app.js`, `/components.js` and platform logos. HTML and every module import share the same source revision query parameter. Browser source imports remain normal relative imports so DOM tests can execute the same files directly.

CSS imports are intentionally ordered. The late phone/tablet layer overrides earlier breakpoints, so moving a rule between files can change the cascade. At startup the HTTP asset loader combines these files in entry-point order into one cached `/styles.css` response, avoiding a CSS request waterfall. No filesystem reads happen per asset request.

## Persistence compatibility

Persistent file paths are configuration-based or relative to the working data directory, never relative to a source module. Moving source files does not migrate runtime data.

| Data                                          | Existing filename                 |
| --------------------------------------------- | --------------------------------- |
| Library, settings and panel instance metadata | `playlists.json`                  |
| Playback recovery                             | `playback.json`                   |
| Import recovery                               | `imports.json`                    |
| Audit journal                                 | `operations.json`                 |
| TeamSpeak identities                          | `identity.txt` / `identity-*.txt` |
| Encrypted Discord credentials                 | `discord-instances.json`          |
| Discord encryption key                        | `discord-secrets.key`             |

Docker continues to start `/app/src/index.ts` with `/data` as the working directory and the existing `radiospeak-data` volume. Source organization does not change public API routes, environment variables, library formats or export/import formats.

## Verification

See [CONTRIBUTING.md](../CONTRIBUTING.md) for commands. The regression suite exercises both platform adapters without joining real servers. Real FFmpeg tests verify audio output locally; actual TeamSpeak/Discord connectivity still depends on deployment credentials, channel permissions and network access.
