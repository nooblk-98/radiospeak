FROM node:24-alpine

# ffmpeg decodes the audio and encodes Opus natively (light enough for small machines).
# yt-dlp is the official zipapp, so it runs on any CPU architecture via python3.
# YouTube needs a JavaScript runtime; Node is already here, so yt-dlp is told to use it.
RUN apk add --no-cache ffmpeg tini python3 \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY config.example.json ./
COPY Dockerfile ./
COPY docker-compose.yml ./

# Runtime state (identity files, playlists.json, optional config.json) lives in /data.
# Runs as root so it can write to a bind-mounted ./data that Docker created as root.
WORKDIR /data
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD node /app/scripts/container-health.mjs

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/index.ts"]
