FROM node:24-alpine

# ffmpeg from Alpine is built with the decoders the radio streams need (MP3, AAC/AAC+, Opus).
# yt-dlp (YouTube/SoundCloud) is the official zipapp, so it runs on any CPU architecture via python3.
# YouTube needs a JavaScript runtime; Node is already here, so yt-dlp is told to use it.
RUN apk add --no-cache ffmpeg tini python3 \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY stations.json config.example.json ./

# Runtime state (config.json, stations.json, schedule.json, identity files) lives in /data.
# Runs as root so it can write to a bind-mounted ./data that Docker created as root.
WORKDIR /data
ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
# Seed the station list on first run, then start the bot.
CMD ["sh", "-c", "[ -f stations.json ] || cp /app/stations.json stations.json; exec node /app/src/index.ts"]
