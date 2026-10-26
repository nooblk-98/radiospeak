# radiospeak

A TeamSpeak 3 / TeamSpeak 6 music bot: YouTube and SoundCloud songs and playlists, saved playlists,
a default playlist for when nobody has requested anything, live radio links and a web control panel.

- **Node.js 22.18+** (runs the TypeScript directly, no build step)
- **[@honeybbq/teamspeak](https://github.com/HoneyBBQ/teamspeak-js)**: pure-TypeScript TeamSpeak voice client
- **yt-dlp**: finds and streams songs (YouTube needs a JavaScript runtime: Deno, or Node via `--js-runtimes node`)
- **ffmpeg**: decodes the audio and encodes Opus

## Features

- **Songs and playlists** from YouTube, SoundCloud and other sites yt-dlp supports, by link or by search words
- **Queue** with play-next, skip, remove, shuffle, loop (one / all), pause and resume (songs continue where they stopped)
- **Default playlist** that plays whenever the queue is empty; a request interrupts it and it picks up again afterwards
- **Saved playlists** built from chat or the web panel (`playlists.json`)
- **Radio stations**: saved stream links, managed in the web panel, play while the queue is empty
- **Fixed bot nickname**, defaulting to `radiospeak`, customizable in Bot & TeamSpeak settings; current song in the description
- **Auto-pause** while nobody is listening in the channel
- **`!join`** moves the bot to your channel
- **Several bots** in one process, e.g. one per channel
- **Web control panel** for phone or desktop

## Setup

```bash
npm install
```

```bash
copy config.example.json config.json
```

Install ffmpeg and yt-dlp. On Windows (yt-dlp brings Deno along):

```bash
winget install Gyan.FFmpeg yt-dlp.yt-dlp
```

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `server` | `host:port` of your TeamSpeak server (port is usually 9987) |
| `serverPassword` | Server password, empty if none |
| `nickname`, `channel`, `channelPassword` | Bot name and first channel to join (`"Music"` or `"Lounge/Music"`). Optional: a channel chosen in the web panel replaces it |
| `volume` | Starting volume, 0-100 |
| `defaultPlaylist` | Optional YouTube playlist link to play when idle; usually left empty and an idle playlist chosen per bot in the web panel |
| `maxPlaylistItems` | Most songs taken from one playlist link |
| `bots` | List of bots; each can override `name`, `nickname`, `channel`, `channelPassword`, `volume`, `defaultPlaylist`, `identityFile` |
| `admins`, `adminGroups` | Unique IDs / server group IDs allowed to delete saved playlists. Both empty = everyone |
| `pauseWhenEmpty`, `emptyGraceSeconds` | Pause after the channel has been empty this long |
| `songInDescription` | Show the current song in the TeamSpeak description; the nickname always stays fixed |
| `web` | `enabled`, `host`, `port`, `password` for the control panel |
| `ffmpegPath`, `ytdlpPath`, `bitrateKbps` | Tools and Opus bitrate |

Each bot saves its identity on first run (`identity.txt` for the first bot). Keep these files so the
bots keep the same unique IDs and any server groups you give them.

## Run

```bash
npm start
```

Test the audio pipeline without a TeamSpeak server (should report ~50 fps and 0 underruns):

```bash
npm run test:audio -- "song name or link"
```

## Docker

Edit the `FMBOT_*` settings in `docker-compose.yml` (server, server password and **web panel password**),
then:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

The compose file publishes the web panel at `http://<server>:48080` (any user name, the password you set).
The fixed Docker volume `radiospeak-data` keeps identity files, playlists, playback checkpoints and optional
`config.json`. `FMBOT_*` variables override that configuration. Keep this volume when upgrading.
Each bot's channel, idle playlist, nickname and the radio stations are set in the web panel and saved
in the same volume, so the compose file needs no per-bot defaults.

**Existing installs using `./data`: migrate before the first deployment with the new compose file.**
On the Docker host, disable scheduled Portainer redeployments for radiospeak while migrating, then run:

```bash
sh scripts/migrate-data.sh radiospeak
docker compose up -d --build
```

The script stops the old container, backs up its actual `/data` directory (including the identity), copies
it to the fixed volume and verifies every file before leaving the bot stopped for deployment. It refuses
to overwrite an existing populated volume and restarts the original container if migration fails. The old
data and the printed backup path remain available. Do not deploy into an empty volume before migrating.
In Portainer, deploy the updated Git stack after running the script on its Docker host.

Portainer Git checkouts can change directories with every commit, so relative `./data` binds can generate
a new TeamSpeak identity after updates. The fixed volume avoids that. If a container is repeatedly replaced
with exit code 0 and `RestartCount=0`, inspect Portainer's GitOps polling/deployment history and Docker events.
Disable polling for that source while investigating; manual Git redeploy remains available.

For moderated TeamSpeak channels, assign the preserved bot identity a permanent server/channel group with
`i_client_talk_power` at least the channel's `i_channel_needed_talk_power` (75 for the example channel).
A temporary “Grant talk power” can expire when the bot reconnects. Showing the song in its description
also requires `b_client_modify_own_description`.

YouTube changes often: rebuild now and then to get a fresh yt-dlp:

```bash
docker compose build --pull
```

## Web control panel

Set `web.enabled` to `true` in your configuration (or `FMBOT_WEB_ENABLED=true`),
then open `http://localhost:8080`. The panel uses modular vanilla HTML, CSS and
JavaScript with no frontend build step. Its dark layout adapts to desktop and
mobile, and the player dock remains available while switching screens.

- **Now playing:** playback, live progress, TeamSpeak channel and listener status.
- **Up next:** drag tracks into order or click a track number to choose a position
  with a keyboard or touch device. Play next, move to top, remove, clear, or save
  the queue. Removed tracks offer Undo for 60 seconds, provided playback and the
  queue have not changed. Estimated wait times account for preceding track lengths;
  paused playback and repeat-one are labelled. Stop clears user requests; Pause keeps them.
- **Collections & playlists:** create, rename, move and delete playlists; group
  them in collections; import public YouTube playlists; reorder or enqueue saved
  tracks. Track tables show 50 rows per page; reordering works across pages.
  Deleting a collection keeps its playlists as standalone lists.
- **Playlist Play now:** clears the bot's queue and starts the playlist at once
  (shuffled when shuffle is on). **Add to queue** appends it instead.
- **Idle playlists:** select one per bot. Requests take priority and the idle
  playlist resumes when they finish. An enabled radio stream takes priority over
  the idle playlist. Deleting an assigned playlist disables that fallback.
- **Search & import:** debounced YouTube/SoundCloud search, result artwork,
  durations and artists, play now, enqueue, and save to a playlist. Search and
  imports need `yt-dlp`.
  Search metadata is cached for 60 seconds (up to 100 searches). Media lookups
  share two process slots with a bounded waiting list; cancelling a browser search
  aborts its lookup. Imports run as background jobs with progress, cancellation,
  unavailable-entry reports, and an optional skip-duplicates checkbox. Alternate
  YouTube links to the same video count as duplicates.
- **Radio stations:** add, rename, edit and delete saved stream URLs (HTTP,
  Icecast, SHOUTcast), shared by all bots. Tune in sets the selected bot's radio:
  it replaces the idle playlist immediately, while user requests still finish
  first. Two SomaFM stations are offered until the list is edited.
- **Bot & TeamSpeak:** customize the fixed bot name, move between available channels, see
  listeners, toggle FFmpeg loudness normalization, shuffle, and repeat. Bot health
  shows process uptime/memory, reconnects, buffer underruns, checkpoint status,
  media lookup load, and the latest disconnect/audio error.

The heart stores favorites in the shared library. Bot volume is the actual
TeamSpeak output gain (0–100%), not browser playback volume. Audio always plays
through the bot. The volume slider sends live updates while dragging, with ordered,
coalesced requests so older values cannot override the final setting. Gain is
applied just before encoding with at most 25 audio frames (0.5 seconds) of lead;
mute stops outgoing music immediately while the track continues. Volume changes
do not restart the decoder or reconnect TeamSpeak. Seeking restarts the decoder and may take time on remote media;
live streams cannot be scrubbed. Normalization changes restart the audio pipeline
at its current position. Listener auto-pause resumes when a listener joins.

The default TeamSpeak nickname is `radiospeak`. Change it under **Bot & TeamSpeak →
Bot name → Save name** (1–30 characters). The name applies to the connected bot and
is saved per bot in the library for subsequent connections and restarts, overriding
`nickname` / `FMBOT_NICKNAME`. If the bot is offline, it uses the saved name on its
next connection. Song changes only update the description; legacy
`showSongInNickname` / `FMBOT_SONG_IN_NICKNAME` settings are ignored.

The panel receives authenticated server-sent events from `/api/events`. Structural
changes push a compact state; elapsed time and health use separate progress events
every second. If SSE is unavailable, polling falls back to 1.5 seconds (5 seconds
while hidden). `StateConnection` emits `track_changed`, `queue_updated`, and
`playback_progress`. Late REST responses cannot overwrite newer pushed state.
`/api/state` contains playlist summaries; tracks load on demand through
`/api/playlists/:id?offset=0&limit=50` (maximum 100 per response). Playlist version
tokens prevent stale edits without posting the entire track order back.

Library data is written atomically to `playlists.json` (or `FMBOT_PLAYLISTS`).
Existing playlist arrays load automatically; the next write upgrades them to a
versioned object containing playlists, stable IDs, collections, favorites, and
per-bot idle selections, channels and nicknames, and radio stations. Back up that file before downgrading to an older release.
Idle selections survive restarts and override configured remote defaults. Playback,
shuffle, volume, and normalization controls apply to the running bot.

Playback recovery is saved separately in `playback.json` (override with
`FMBOT_PLAYBACK`). Checkpoints are queued on player changes and every 10 seconds,
including the current track, elapsed time, queue, idle playlist cursor, radio,
volume, shuffle, repeat, normalization, and user pause/stop state. A clean shutdown
saves before stopping the decoder. Writes are asynchronous, coalesced over 50 ms,
serialized, and atomically renamed. Shutdown waits for pending saves. After an unexpected process restart, playback
resumes from the last checkpoint once TeamSpeak finishes connecting; up to 10
seconds can be replayed. The existing Docker `/data` mount preserves this file.

Temporary TeamSpeak disconnects pause the audio pipeline and hold the current
track/queue until the server's channel list is ready again. Reconnecting does not
reload the default playlist. Startup logs include the process ID, and restored
checkpoints and disconnect reasons are logged, so process restarts can be
distinguished from transport reconnects. An external restart such as a Docker
out-of-memory kill still needs server/container logs to diagnose.

Interrupted audio retries from its current position up to twice, with 1- and
2-second backoff. A stream that supplies no buffered audio for 30 seconds also
enters recovery. Missing tools and known permanent media errors skip immediately;
the queue remains intact during retries. Health and the player page show recovery.

**Prepare the next track** in Bot & TeamSpeak settings is optional and off by
default. During the last 15 seconds of a known-length track, one upcoming track
is decoded into a bounded buffer. The prepared pipeline is promoted at the next
transition; its audio is never sent early. Queue changes, seeks, normalization
changes, disabling prebuffering, and Stop discard stale preparation. Preparing
another track can temporarily double audio process usage; enable it only when
the server has spare CPU and memory. The setting is included in playback checkpoints.

Playlist names can contain spaces. Use their 1-based number from `!pl` in chat
commands when a name contains spaces, for example `!pl add 2 <link>`.

### Development checks

```bash
npm ci
npm run check
npm test
```

Tests cover library migration/persistence, player controls, authenticated HTTP
routes, stale queue/playlist edits, input validation, and a DOM workflow through
the actual panel and local API. The DOM test supplies deterministic media results;
it does not require TeamSpeak, FFmpeg, or a network media provider.
Additional tests cover asynchronous checkpoint bursts, SSE authentication and
client merging, lookup caching/cancellation/concurrency, import progress and
duplicates, paged edits, Undo, stalled streams, bounded retries, and prebuffer
promotion/cancellation using controlled child-process streams.

To additionally verify live gain against real FFmpeg/Opus output, set `FFMPEG_PATH`
to your FFmpeg executable and run `npm test`. These optional local tests synthesize
a tone, change gain during playback with normalization on and off, then decode the
captured Opus packets and compare their measured amplitudes. They require no
TeamSpeak connection or external media service.

## Chat commands

Send these in the bot's channel or as a private message to the bot:

| Command | |
| --- | --- |
| `!play <link or search>` | Add a song or playlist to the queue (`!play` alone starts/resumes) |
| `!playall <link>` | Queue the whole playlist from a song-in-a-playlist link |
| `!playnext <link or search>` | Play right after the current song |
| `!search <words>` then `!pick <n> [n...]` | Choose from 5 results |
| `!pause`, `!resume`, `!skip [n]`, `!stop` | Playback |
| `!queue [page]`, `!remove <n>`, `!clear`, `!shuffle`, `!loop [off\|one\|all]` | Queue |
| `!np`, `!vol [0-100]` | Now playing, volume |
| `!pl` | List saved playlists |
| `!pl new <name>` | Create one |
| `!pl add <name> [link or search]` | Add songs (no link = the current song; a playlist link adds all of it) |
| `!pl save <name>` | Save the current queue |
| `!pl show <name> [page]`, `!pl remove <name> <n>` | View / edit |
| `!pl play <name> [shuffle]` | Queue a saved playlist |
| `!pl delete <name>` | Delete (admin) |
| `!radio <station\|stream link\|off>`, `!radio list` | Live radio while the queue is empty (saved station name or number) |
| `!join`, `!bots`, `!help` | Other |

## Notes

- For best quality, set the bot's channel codec to **Opus Music**.
- If the log shows **buffer underruns**, the machine or its network can't keep up; audio will sound choppy.
- Setting its own description needs the `b_client_modify_own_description` permission (granted by default).
- If TeamSpeak disconnects, the bot reconnects; after a clone or flood ban it waits at least 60 s before retrying.
- With several bots in one channel, only the first one answers channel chat.
