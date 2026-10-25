# radiospeak

A TeamSpeak 3 / TeamSpeak 6 bot that streams internet FM radio into a channel.

- **Node.js 22.18+** (runs the TypeScript directly, no build step)
- **[@honeybbq/teamspeak](https://github.com/HoneyBBQ/teamspeak-js)**: pure-TypeScript TeamSpeak voice client
- **ffmpeg**: pulls the radio stream and encodes it to Opus (20 ms frames, Opus Music codec)

## Setup

```bash
npm install
```

```bash
copy config.example.json config.json
```

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `server` | `host:port` of your TeamSpeak server (port is usually 9987) |
| `serverPassword` | Server password, empty if none |
| `nickname` | Bot name shown in TeamSpeak |
| `channel` / `channelPassword` | Channel to join (e.g. `"Music"` or `"Lounge/Radio"`), empty for default |
| `ffmpegPath` | `ffmpeg` if it's on PATH, otherwise the full path to `ffmpeg.exe` |
| `bitrateKbps` | Opus bitrate (96 is a good default) |
| `volume` | 0-100 |
| `autoplay` / `defaultStation` | Start playing this station id on connect |
| `admins` | Client unique IDs allowed to `!add` / `!remove`. Empty = everyone |

The bot's identity is saved to `identity.txt` on first run. Keep this file so the
bot keeps the same unique ID (and any server groups you give it).

## Run

```bash
npm start
```

Test the audio pipeline without a TeamSpeak server (should report ~50 fps):

```bash
npm run test:audio
```

## Docker

Edit the `FMBOT_*` settings in `docker-compose.yml` (server address, password, channel), then:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

The `./data` folder holds the bot's `identity.txt` and `stations.json` (seeded from the repo's
list on first start). Edit `data/stations.json` to add stations, then `docker compose restart`.
A `data/config.json` is also read if present; `FMBOT_*` variables override it.

The bot only makes outgoing connections, so no ports need to be published.

## Stations

Stations live in `stations.json`. Add more by editing the file:

```json
[
  { "id": "shaafm", "name": "Shaa FM", "url": "https://radio.lotustechnologieslk.net:2020/stream/shaafmgarden" },
  { "id": "another", "name": "Another FM", "url": "https://example.com/stream" }
]
```

Or from TeamSpeak chat: `!add another https://example.com/stream Another FM`

## Chat commands

Send these in the bot's channel or as a private message to the bot:

| Command | |
| --- | --- |
| `!help` | Command list |
| `!list` | Show stations |
| `!play [n\|id\|name]` | Play a station (no argument: resume) |
| `!stop` | Stop |
| `!next` / `!prev` | Switch station |
| `!vol [0-100]` | Show or set volume (restarts the stream briefly) |
| `!np` | What's playing |
| `!add <id> <url> [name]` | Add a station |
| `!remove <id>` | Remove a station |

## Notes

- For best quality, set the bot's channel codec to **Opus Music**.
- If the stream drops, ffmpeg reconnects automatically. If ffmpeg exits, the bot restarts it
  with backoff (2 s, doubling up to 30 s). If TeamSpeak disconnects, the client reconnects.
