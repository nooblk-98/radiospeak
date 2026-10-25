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
- **Radio**: any live stream link plays while the queue is empty
- **Song in the nickname** (e.g. `Music Bot | Song title`) and in the description
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
| `nickname`, `channel`, `channelPassword` | Bot name and channel to join (`"Music"` or `"Lounge/Music"`) |
| `volume` | Starting volume, 0-100 |
| `defaultPlaylist` | YouTube playlist link (or a song link from inside one) to play when idle |
| `maxPlaylistItems` | Most songs taken from one playlist link |
| `bots` | List of bots; each can override `name`, `nickname`, `channel`, `channelPassword`, `volume`, `defaultPlaylist`, `identityFile` |
| `admins`, `adminGroups` | Unique IDs / server group IDs allowed to delete saved playlists. Both empty = everyone |
| `pauseWhenEmpty`, `emptyGraceSeconds` | Pause after the channel has been empty this long |
| `showSongInNickname`, `songInDescription` | What to show in TeamSpeak |
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

Edit the `FMBOT_*` settings in `docker-compose.yml` (server, password, channel, default playlist and
**web panel password**), then:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

The web panel is on port 8080 (any user name, the password you set). The `./data` folder keeps the identity
files and `playlists.json`. A `data/config.json` is also read if present; `FMBOT_*` variables override it.
YouTube changes often: rebuild now and then to get a fresh yt-dlp:

```bash
docker compose build --pull
```

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
| `!radio <stream link\|off>` | Live radio while the queue is empty |
| `!join`, `!bots`, `!help` | Other |

## Notes

- For best quality, set the bot's channel codec to **Opus Music**.
- If the log shows **buffer underruns**, the machine or its network can't keep up; audio will sound choppy.
- Setting its own description needs the `b_client_modify_own_description` permission (granted by default).
- If TeamSpeak disconnects, the bot reconnects; after a clone or flood ban it waits at least 60 s before retrying.
- With several bots in one channel, only the first one answers channel chat.
