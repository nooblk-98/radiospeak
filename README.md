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
| `playlists.json` (`FMBOT_PLAYLISTS`) | Library, per-bot settings, schedules, playback history, named account hashes and chat roles |
| `playback.json` (`FMBOT_PLAYBACK`) | Playback checkpoints: track, position, queue, radio, volume and modes |
| `imports.json` (beside the library file) | Recoverable import jobs and continuation cursors |

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
- **Prepare the next track** (optional, off by default) decodes the upcoming song during the last 15 seconds. All bots share two preparation slots. Pausing releases speculative work; long-paused songs release their audio processes and resume from their saved position.
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
- Search results are cached for 60 seconds and small URL metadata lookups for 120 seconds. Identical pending lookups share one process. Cancelling one consumer leaves the lookup running for any others. Media lookups share two process slots.
- Library writes are asynchronous, coalesced and atomic. HTTP mutations await their durable save, and graceful shutdown flushes the library, playback checkpoints and imports. Only a changed selected playlist reloads a bot's idle tracks.
- Structural updates use revision counters, and each SSE broadcast is serialized once for all viewers. Signed-out, expired or revoked accounts lose their live stream as well as API access.

</details>

### Auto-deploy from GitHub

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) tests application changes on `main`, including real FFmpeg/Opus output. Documentation-only pushes do not restart the bot. Configure `PORTAINER_WEBHOOK_URL` and `DEPLOY_HEALTH_URL` (the public `https://<panel>/healthz` URL) as repository secrets under **Settings → Secrets and variables → Actions**.

Every push deploys immediately; there is no wait for current songs. Deployment first checks whether the expected source is already healthy. Otherwise it triggers the webhook once and waits up to three minutes for the matching source revision, successful persistence and connected bot instances. A lost webhook response does not trigger duplicate redeploys. Manual workflow runs have a **force_redeploy** option for rebuilding tool versions at the same source revision.

`/healthz` is a public, minimal status endpoint; it contains no playlists, identities, accounts or connection secrets. Docker checks process/web liveness; GitHub additionally checks bot readiness. An unhealthy Docker status alone does not restart the bot.

## Performance, schedules and access

**Bot & TeamSpeak → Performance & requests** provides per-instance settings:

- **Audio profile:** High quality retains Opus complexity 10. Balanced uses complexity 5; normalization remains independently selectable. Quality and CPU tradeoffs depend on the source. Existing installs keep High quality.
- **Request limits:** default 500 tracks total, 50 queued per listener and a three-second listener cooldown. DJs/admins bypass per-listener limits and cooldowns; the total queue limit still applies. Requests that exceed a limit are rejected as a whole. Existing recovered queues are preserved.
- **Idle release:** paused audio processes are released after 120 seconds by default. Resume keeps the track position. Live radio resumes at its live position.
- **Radio fallback order:** select stations to try after two consecutive failures. Retries retain their bounded backoff, user requests take priority, and the health card explains a fallback switch.
- **Avoid recent idle tracks:** skip the last ten played URLs while choosing an idle track, when another track is available. User requests and repeat modes remain explicit choices.

**Playlist schedules** choose a bot's idle playlist by weekday and local time. The default zone is `Asia/Colombo`; any valid IANA time zone is accepted. Overnight schedules belong to their starting day. Enabled overlaps are rejected, and a bot's enabled schedules use the same zone. Checks run every 15 seconds; the selection applies to subsequent idle tracks and does not interrupt a user request. Outside a schedule, the saved default returns. An enabled radio station takes priority.

**Playback history** retains 200 entries per bot across restarts, including requester, time and failures. Request a track again from that view; requester totals summarize those retained entries. TeamSpeak also supports `!history`.

**Import recovery:** the public-playlist dialog previews up to ten entries and shows the configured batch limit. Imports save tracks in batches and persist their cursor in `imports.json`. Use **Continue next batch**, **Resume import** or **Retry unavailable entries** from the notification bell. Cancel keeps tracks already saved. Entry identifiers prevent duplicates after interruption even when URL deduplication is off. If the provider changes playlist order, start a new import with duplicate skipping enabled to refresh it.

**Access & roles:** sign in as `owner` with the existing panel password to add named accounts. Passwords use salted scrypt hashes. Listeners can search, enqueue, remove their own requests and vote to skip. DJs manage playback, playlists, stations and schedules. Administrators also manage accounts and instances. Named account passwords need at least ten characters; changing or deleting an account invalidates its sessions. Scripts retain administrator Basic authentication using the panel password.

TeamSpeak chat role enforcement is opt-in to preserve existing command behavior. Enable it in **Access & roles**, then assign client unique IDs or server-group IDs. Unlisted clients become listeners; existing configured bot admins retain administrator access. A listener's `!skip` is a vote, with one vote per identity and a threshold of half the channel's listeners, rounded up.

Compose defaults to four CPU cores, 4 GiB memory, 512 tasks and rotated logs. Override `FMBOT_CPU_LIMIT`, `FMBOT_MEMORY_LIMIT` and `FMBOT_PIDS_LIMIT` in the Compose environment for your host. These are ceilings, not reserved resources.

Run the isolated synthetic benchmark with `npm run benchmark:audio` (`FFMPEG_PATH` overrides the executable). On the deployed Linux host, the ten-pipeline, High-quality/normalization-on test sustained 50 fps with zero underruns, 1,256 MiB combined RSS (about 1.23 GiB) and 1.15 CPU cores during a short steady-state window. It uses generated audio, not YouTube extraction, and does not measure long-term memory growth or music quality. Profile comparisons were noisy, so the default quality was retained.

## Library management and notifications

The top-right notification bell contains action results, Undo, import progress, retry/continue controls and recovery alerts. It keeps the workspace clear, remembers read state per panel account in this browser, and does not open automatically. Use **Mark all read** to clear the unread badge.

Inside a playlist, filter by title/artist or show duplicate copies. Select tracks across pages, or select every matching track, then copy, move, remove, sort or deduplicate them. Bulk changes preserve original positions and reject stale source/destination versions. Duplicate removal retains the first occurrence of a normalized media URL.

Administrators can **Export settings & playlists** under Bot & TeamSpeak. Import previews counts, validates the whole JSON file, assigns new IDs and unique names, then merges it into the library. The optional preferences checkbox applies settings only to matching bot instance IDs; imported schedules replace existing schedules for affected bots. Exports include media URLs, channels, names, audio preferences and deployment policy. They exclude TeamSpeak identities, server credentials, account password hashes, history and deployment secrets. There are no automatic backups. Export files are limited to 16 MiB / 100,000 tracks.

The administrator audit log retains the latest 2,000 successful panel changes and state-changing TeamSpeak commands, including time, actor and resource. It excludes request bodies, command arguments, query strings and passwords.

## Audio monitoring

Bot health shows the output RMS level in dBFS. Optional silence monitoring measures decoded source audio before volume gain; mute and pause do not generate alerts. Configure a threshold and duration under Performance & requests. Optional radio failover switches to the next configured station after sustained silence; it is disabled by default.

FFmpeg audio decoding, encoding and filter pools use one worker each to keep multiple bots within the container PID budget. Audio gain waits for encoder credit instead of polling. Opus sends use the next 20 ms frame deadline, wake on incoming buffered data, and retain the 30-second stall watchdog. Health includes mean/max frame lateness so deployments can be compared with the isolated benchmark.

Run an isolated longer test with `npm run soak:audio -- --seconds 7200 --bots 3` and `FFMPEG_PATH` set as needed. It uses temporary data, generated audio, real FFmpeg/Opus pipelines, track transitions, queue requests, pause/resume, radio switches, durable synthetic imports and checkpoints. JSON output reports process counts, Node RSS, event-loop delay, frame timing and underruns; it never joins TeamSpeak or reads production data. Synthetic tests do not measure media-provider reliability or a real server's network jitter.

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
