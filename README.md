# radiospeak

A TeamSpeak 3 / TeamSpeak 6 bot that streams internet FM radio into your channels, with
43 Sri Lankan stations built in, online station search, YouTube/SoundCloud, a schedule and a web control panel.

- **Node.js 22.18+** (runs the TypeScript directly, no build step)
- **[@honeybbq/teamspeak](https://github.com/HoneyBBQ/teamspeak-js)**: pure-TypeScript TeamSpeak voice client
- **ffmpeg**: decodes the radio streams
- **yt-dlp** (optional): YouTube / SoundCloud playback

## Features

- **Radio** from `stations.json`: Sinhala, English, Tamil and SLBC stations out of the box
- **Station search** across ~50,000 stations at [radio-browser.info](https://www.radio-browser.info), add with one command
- **Song titles** read from the stream (when the station sends them) and shown in the bot's description
- **Station in the nickname**, e.g. `FM Radio | Hiru FM`
- **Instant volume** changes with no gap
- **Backup URLs** per station: if a stream keeps failing, the next one is tried
- **Auto-pause** while nobody is listening in the channel, resumes when someone joins
- **`!join`** moves the bot to your channel
- **YouTube / SoundCloud** tracks with a queue; the radio resumes when the queue ends
- **Schedule**: play a station or stop at set times, on chosen days
- **Admins** by client unique ID or server group
- **Several bots** in one process, e.g. one per channel
- **Web control panel** for phone or desktop

## Setup

```bash
npm install
```

```bash
copy config.example.json config.json
```

Install ffmpeg (and yt-dlp for YouTube). On Windows:

```bash
winget install Gyan.FFmpeg yt-dlp.yt-dlp
```

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `server` | `host:port` of your TeamSpeak server (port is usually 9987) |
| `serverPassword` | Server password, empty if none |
| `nickname`, `channel`, `channelPassword` | Bot name and channel to join (`"Music"` or `"Lounge/Radio"`) |
| `volume`, `autoplay`, `defaultStation` | Starting volume (0-100), and what to play on connect |
| `bots` | List of bots; each can override `name`, `nickname`, `channel`, `channelPassword`, `volume`, `defaultStation`, `identityFile` |
| `admins`, `adminGroups` | Unique IDs / server group IDs allowed to run admin commands. Both empty = everyone |
| `pauseWhenEmpty`, `emptyGraceSeconds` | Pause after the channel has been empty this long |
| `showStationInNickname`, `songInDescription`, `announceSongs` | What to show in TeamSpeak |
| `timezone` | Time zone for the schedule, e.g. `Asia/Colombo` |
| `web` | `enabled`, `host`, `port`, `password` for the control panel |
| `ffmpegPath`, `ytdlpPath`, `bitrateKbps` | Tools and Opus bitrate |

Each bot saves its identity on first run (`identity.txt` for the first bot). Keep these files so the
bots keep the same unique IDs and any server groups you give them.

## Run

```bash
npm start
```

Test the audio pipeline without a TeamSpeak server (should report ~50 fps):

```bash
npm run test:audio
```

## Docker

Edit the `FMBOT_*` settings in `docker-compose.yml` (server, password, channel and **web panel password**), then:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

The web panel is on port 8080. The `./data` folder keeps the identity files, `stations.json` (seeded from
the repo on first start) and `schedule.json`. A `data/config.json` is also read if present; `FMBOT_*`
variables override it. Rebuild the image now and then (`docker compose build --pull`) to get a fresh
yt-dlp when YouTube changes something.

## Chat commands

Send these in the bot's channel or as a private message to the bot:

| Command | |
| --- | --- |
| `!help` | Command list |
| `!list` | Show stations |
| `!play [n\|id\|name]` | Play a station (no argument: resume) |
| `!stop`, `!next`, `!prev` | Stop / switch station |
| `!vol [0-100]` | Show or set volume |
| `!np` | What's playing, with the song title |
| `!search <name, country or genre>` | Find stations online, e.g. `!search sri lanka`, `!search jazz` |
| `!yt <link or search words>` | Play a YouTube/SoundCloud track; radio resumes after |
| `!skip`, `!queue`, `!clear` | Manage the track queue |
| `!join` | Move the bot to your channel |
| `!bots` | List all bots and what they play |
| `!schedule` | Show the schedule |

Admin commands:

| Command | |
| --- | --- |
| `!add <n>` | Add result *n* from your last `!search` |
| `!add <id> <url> [name]` / `!add <url> [name]` | Add a station by URL |
| `!remove <id>` | Remove a station |
| `!backup <id> <url>` | Add a backup URL to a station |
| `!schedule add 08:00 <station\|stop> [mon,tue,...] [vol=40] [bot=name]` | Add a schedule entry |
| `!schedule remove <n>` | Remove a schedule entry |

## Notes

- For best quality, set the bot's channel codec to **Opus Music**.
- Setting its own description needs the `b_client_modify_own_description` permission (granted by default).
- If TeamSpeak disconnects, the bot reconnects; if the server reports a clone or flood ban it waits at least
  60 s before retrying.
- With several bots in one channel, only the first one answers channel chat.
