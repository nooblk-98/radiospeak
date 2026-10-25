FROM node:24-alpine

# ffmpeg from Alpine is built with libopus, which the radio pipeline needs.
RUN apk add --no-cache ffmpeg tini

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY stations.json config.example.json ./

# Runtime state (config.json, stations.json, identity.txt) lives in /data.
# Runs as root so it can write to a bind-mounted ./data that Docker created as root.
WORKDIR /data
ENV NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
# Seed the station list on first run, then start the bot.
CMD ["sh", "-c", "[ -f stations.json ] || cp /app/stations.json stations.json; exec node /app/src/index.ts"]
