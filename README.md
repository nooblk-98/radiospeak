<div align="center">

<img src="docs/logo.svg" alt="radiospeak logo" width="96" height="96">

# radiospeak

**Your channel. Your soundtrack.**<br>
A self-hosted music bot for TeamSpeak 3 and TeamSpeak 6, with a web control panel.

[![Node.js](https://img.shields.io/badge/Node.js-22.18%2B-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build%20step-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)](docker-compose.yml)
[![TeamSpeak](https://img.shields.io/badge/TeamSpeak-3%20%7C%206-2580c3?logo=teamspeak&logoColor=white)](https://teamspeak.com)

[Features](#features) • [Quick start](#quick-start) • [Configuration](#configuration) • [Chat commands](#chat-commands) • [How it works](#how-it-works) • [Development](#development)

![radiospeak web panel: now playing](docs/screenshots/now-playing.jpg)

</div>

radiospeak joins your TeamSpeak server as a regular voice client and streams music from YouTube, SoundCloud, live radio and anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports. Listeners control it from channel chat. Admins use a web panel to manage the queue, saved playlists, radio stations and several bots. Everything runs in one Node.js process without a native TeamSpeak client, thanks to [@honeybbq/teamspeak](https://github.com/HoneyBBQ/teamspeak-js).

## Features

- **Play almost anything**: songs and playlists from YouTube, SoundCloud and other sites yt-dlp supports, by link or search words.
- **Real queue**: play next, drag to reorder, remove with Undo, shuffle, repeat one or all, and pause/resume where the song stopped.
- **Saved library**: playlists, collections and favorites. Import public YouTube playlists in the background with duplicate detection.
- **Never silent**: an idle playlist or live radio station takes over whenever the queue is empty. Requests always come first.
- **Radio stations**: save Icecast, SHOUTcast or plain HTTP streams and tune in with one click. The current song title appears in the panel.
- **Multi-instance**: add and remove bot instances from the panel and switch between them from the top bar. Each is its own TeamSpeak client with a separate channel, name, queue, volume and idle playlist.
- **Listener-aware**: pauses when nobody is listening and resumes when someone joins, and greets people who join its channel with the main chat commands (once per person per half hour; can be turned off per bot).
- **Resilient playback**: checkpoints survive restarts, reconnects keep the queue, and failed streams retry from the same position.
- **Live web panel**: dark, responsive and mobile-friendly. Updates arrive over server-sent events, and there is no frontend build step.

<table>
  <tr>
    <td><img src="docs/screenshots/queue.jpg" alt="Up next queue"></td>
    <td><img src="docs/screenshots/library.jpg" alt="Collections and playlists"></td>
  </tr>
  <tr>
    <td align="center"><sub>Up next: reorder, play next, undo removals</sub></td>
    <td align="center"><sub>Collections, playlists and favorites</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/search.jpg" alt="Search and import"></td>
    <td><img src="docs/screenshots/playlist.jpg" alt="Playlist detail"></td>
  </tr>
  <tr>
    <td align="center"><sub>Search YouTube and SoundCloud</sub></td>
    <td align="center"><sub>Play now, add to queue or set as idle playlist</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/radio.jpg" alt="Radio stations"></td>
    <td><img src="docs/screenshots/settings.jpg" alt="Bot and TeamSpeak settings"></td>
  </tr>
  <tr>
    <td align="center"><sub>Saved radio stations</sub></td>
    <td align="center"><sub>Channel, playback and idle playlist per bot</sub></td>
  </tr>
</table>

## Quick start

### With Docker (recommended)

The image includes Node.js, FFmpeg and yt-dlp.

1. Edit the `FMBOT_*` variables in [docker-compose.yml](docker-compose.yml). You need at least `FMBOT_SERVER` and `FMBOT_WEB_PASSWORD`.
2. Start it:

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```

3. Open the panel at `http://<server>:48080` and sign in with the password you set.
4. Under **Bot & TeamSpeak**, pick the bot's channel. It rejoins that channel after every reconnect and restart.
5. Create or import a playlist and click **Set as idle playlist**, or tune in to a station under **Radio stations**.

> [!NOTE]
> The channel, idle playlist, nickname and radio stations are set per bot in the panel and stored on the `radiospeak-data` volume, so the compose file needs no per-bot defaults. Keep that volume when you upgrade: it also holds each bot's TeamSpeak identity.

> [!TIP]
> YouTube changes often. Rebuild now and then to pick up a fresh yt-dlp: `docker compose build --pull && docker compose up -d`.

### From source

Requires **Node.js 22.18+**, **FFmpeg** and **yt-dlp**. For YouTube, yt-dlp also needs a JavaScript runtime: Deno, or Node via `--js-runtimes node`.

```bash
# Windows example; yt-dlp brings Deno along
winget install Gyan.FFmpeg yt-dlp.yt-dlp

npm install
cp config.example.json config.json   # then edit server and web settings
npm start
```

Test the audio pipeline without a TeamSpeak server. It should report ~50 fps and 0 underruns:

```bash
npm run test:audio -- "song name or link"
```

## Configuration

Settings come from `config.json` (path set by `FMBOT_CONFIG`). Any `FMBOT_*` environment variable overrides the file.

| `config.json` key | Environment variable | Description |
| --- | --- | --- |
| `server` | `FMBOT_SERVER` | `host:port` of the TeamSpeak server (usually port 9987) |
| `serverPassword` | `FMBOT_SERVER_PASSWORD` | Server password, empty if none |
| `nickname` | `FMBOT_NICKNAME` | Initial bot name (default `radiospeak`). A name saved in the panel takes precedence |
| `channel`, `channelPassword` | `FMBOT_CHANNEL`, `FMBOT_CHANNEL_PASSWORD` | Optional first channel (`"Music"` or `"Lounge/Music"`). A channel chosen in the panel replaces it |
| `volume` | `FMBOT_VOLUME` | Starting volume, 0–100 |
| `defaultPlaylist` | `FMBOT_DEFAULT_PLAYLIST` | Optional YouTube playlist link for idle play. Usually left empty in favor of the panel's idle playlist |
| `maxPlaylistItems` | `FMBOT_MAX_PLAYLIST_ITEMS` | Most songs taken from one playlist link (default 300) |
| `bitrateKbps` | `FMBOT_BITRATE` | Opus bitrate (default 96) |
| `admins`, `adminGroups` | `FMBOT_ADMINS`, `FMBOT_ADMIN_GROUPS` | Unique IDs / server group IDs allowed to delete saved playlists. Both empty means everyone |
| `pauseWhenEmpty`, `emptyGraceSeconds` | `FMBOT_PAUSE_WHEN_EMPTY` | Pause after the channel has been empty this long (default 15 s) |
| `songInDescription` | `FMBOT_SONG_IN_DESCRIPTION` | Show the current song in the bot's description. The nickname never changes |
| `web.enabled`, `web.host`, `web.port`, `web.password` | `FMBOT_WEB_ENABLED`, `FMBOT_WEB_HOST`, `FMBOT_WEB_PORT`, `FMBOT_WEB_PASSWORD` | Web panel and its sign-in password |
| `bots` | `FMBOT_BOTS` (JSON) | Several bots. Each can override `name`, `nickname`, `channel`, `channelPassword`, `volume`, `defaultPlaylist`, `identityFile` |
| `ffmpegPath`, `ytdlpPath`, `identityLevel`, `commandPrefix` | | Tool paths, identity security level (default 8), chat prefix (default `!`) |

The bot keeps its state in its working directory (`/data` in Docker):

| File | Contents |
| --- | --- |
| `identity.txt`, `identity-<name>.txt` | Each bot's TeamSpeak identity. Keep these so server groups stick to the bots |
| `playlists.json` (`FMBOT_PLAYLISTS`) | Library: playlists, collections, favorites, radio stations, and per-bot channels, nicknames and idle playlists |
| `playback.json` (`FMBOT_PLAYBACK`) | Playback checkpoints: track, position, queue, radio, volume and modes |

> [!WARNING]
> If the panel has no password, the sign-in page is skipped, so set `web.host` to `127.0.0.1`. With a password, the panel is still plain HTTP, so put it behind a reverse proxy with TLS before exposing it to the internet.

## Chat commands

Send these in the bot's channel or as a private message to the bot:

| Command | Description |
| --- | --- |
| `!play <link or search>` | Add a song or playlist to the queue (`!play` alone starts/resumes) |
| `!playall <link>` | Queue the whole playlist from a song-in-a-playlist link |
| `!playnext <link or search>` | Play right after the current song |
| `!search <words>` then `!pick <n> [n...]` | Choose from 5 results |
| `!pause`, `!resume`, `!skip [n]`, `!stop` | Playback |
| `!queue [page]`, `!remove <n>`, `!clear`, `!shuffle`, `!loop [off\|one\|all]` | Queue |
| `!np`, `!vol [0-100]` | Now playing, volume |
| `!pl`, `!pl new <name>`, `!pl show <name> [page]` | List, create and view saved playlists |
| `!pl add <name> [link or search]` | Add songs (no link adds the current song; a playlist link adds all of it) |
| `!pl save <name>`, `!pl play <name> [shuffle]` | Save the queue / queue a saved playlist |
| `!pl remove <name> <n>`, `!pl delete <name>` | Edit / delete (delete is admin only) |
| `!radio <station\|stream link\|off>`, `!radio list` | Live radio while the queue is empty (saved station name or number) |
| `!join`, `!bots`, `!help` | Move the bot to your channel, list bots, help |

Playlist names can contain spaces. In commands, use the playlist's number from `!pl` instead, for example `!pl add 2 <link>`.

## TeamSpeak setup

> [!IMPORTANT]
> In moderated channels, give the bot's identity a **permanent** server or channel group whose `i_client_talk_power` is at least the channel's `i_channel_needed_talk_power`. A temporary "Grant talk power" is lost when the bot reconnects. When the bot can't be heard, it says so in chat and in the panel.

- Set the bot's channel codec to **Opus Music** for the best quality.
- Showing the song in the description needs `b_client_modify_own_description` (granted by default).
- With several bots in one channel, only the first one answers channel chat.
- After a clone or flood ban, the bot waits at least 60 seconds before reconnecting.
- **Buffer underruns** in the log mean the machine or its network can't keep up, and audio will sound choppy.

## How it works

<details>
<summary><strong>Playback order</strong></summary>

1. User requests (queue) always play first. A request interrupts an idle-playlist song immediately.
2. When the queue is empty, the bot's **radio station** plays if one is set.
3. Otherwise the bot's **idle playlist** plays on repeat and keeps its place between requests.

**Play now** on a playlist clears the queue and starts that playlist at once, shuffled when shuffle is on. **Add to queue** appends it instead. **Stop** clears requests and holds silence until something is played again.

</details>

<details>
<summary><strong>Reliability and recovery</strong></summary>

- Checkpoints are saved on every player change and every 10 seconds, with atomic, coalesced writes. After an unexpected restart, playback resumes from the last checkpoint once TeamSpeak reconnects. Up to 10 seconds may replay.
- A TeamSpeak disconnect pauses the audio pipeline and holds the track and queue until the channel list is ready again.
- Interrupted audio retries from its current position up to twice. A stream that delivers nothing for 30 seconds also enters recovery. Permanent media errors skip immediately.
- **Prepare the next track** (optional, off by default) decodes the upcoming song during the last 15 seconds of the current one. It uses extra CPU and memory.
- Bot volume is the real TeamSpeak output gain, applied just before encoding with at most 0.5 s of lead. Changing it never restarts the decoder.

</details>

<details>
<summary><strong>Web panel internals</strong></summary>

- Signing in sets an HttpOnly, SameSite session cookie, valid for 12 hours or 30 days with **Keep me signed in**. Sessions are signed with a key derived from the panel password, so they survive restarts, and changing the password signs everyone out. **Sign out** revokes the session.
- Five wrong passwords from one address lock sign-in for that address for 15 minutes.
- Scripts can call `/api/*` with HTTP Basic auth (any user name plus the password). Panel pages always need a session.
- The panel is modular vanilla HTML, CSS and JavaScript in [src/web](src/web), served by the bot itself.
- Live updates use authenticated server-sent events from `/api/events`. Structural changes push compact state, and elapsed time and health use lightweight progress events. If SSE is unavailable, the panel falls back to polling.
- `/api/state` contains playlist summaries. Tracks load on demand from `/api/playlists/:id?offset=0&limit=50`. Version tokens reject stale edits.
- Search results are cached for 60 seconds. Media lookups share two process slots, and cancelling a search aborts its lookup.

</details>

### Auto-deploy from GitHub

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) tests every push to `main` and then calls a Portainer stack webhook to redeploy. Add the webhook URL as the `PORTAINER_WEBHOOK_URL` repository secret (**Settings → Secrets and variables → Actions**). Keep it secret: anyone with the URL can redeploy the stack.

## Upgrading existing Docker installs

Older versions bind-mounted `./data`. Portainer Git checkouts can change that path with every commit, which creates a new TeamSpeak identity. The fixed `radiospeak-data` volume avoids this. Migrate once before deploying the new compose file:

```bash
sh scripts/migrate-data.sh radiospeak
docker compose up -d --build
```

The script stops the old container, backs up its `/data` (including identities), copies it to the volume and verifies every file. It refuses to overwrite a populated volume and restarts the original container if anything fails.

> [!CAUTION]
> Don't deploy into an empty volume before migrating, or the bot starts with a new identity and an empty library. Pause scheduled Portainer redeployments while migrating.

## Development

```bash
npm ci
npm run check   # TypeScript type check
npm test        # unit, HTTP and DOM tests (no TeamSpeak, FFmpeg or network needed)
```

The tests cover library persistence and migration, player controls, the authenticated HTTP API, stale-edit protection, SSE, imports, retries and prebuffering, plus a jsdom workflow through the real panel. To also check live gain against real FFmpeg/Opus output, set `FFMPEG_PATH` to your FFmpeg executable before running `npm test`.

```text
src/
├── index.ts         # entry point: loads config, starts bots and the web panel
├── bot.ts           # TeamSpeak connection, presence, listeners, talk power
├── player.ts        # queue, idle playlist, radio, FFmpeg/Opus pipeline
├── commands.ts      # chat commands
├── web.ts           # HTTP API, SSE and static panel
├── store.ts         # library (playlists.json)
├── playback-store.ts# checkpoints (playback.json)
├── ytdlp.ts         # search, resolution and lookup pool
└── web/             # panel: index.html, app.js, components.js, styles.css
```
