#!/bin/sh
# Migrate a running bot's /data to the fixed volume without changing its identity.
set -eu

container=${1:-radiospeak}
volume=radiospeak-data
container_id=$(docker inspect --format '{{.Id}}' "$container")
# Config.Image names an available image on both classic and containerd-backed Docker.
# Container .Image can be a config digest that the containerd image store cannot run.
image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
docker image inspect "$image" >/dev/null
current_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id")
if [ "$current_volume" = "$volume" ]; then
  echo "Already using $volume; no migration needed."
  exit 0
fi

docker volume create --label com.docker.compose.project=radiospeak --label com.docker.compose.volume=radiospeak-data "$volume" >/dev/null
docker run --rm --entrypoint sh -v "$volume:/target" "$image" -ec \
  'test -z "$(ls -A /target)" || { echo "Target volume is not empty; refusing to overwrite it." >&2; exit 1; }'

backup=$(mktemp -d "${TMPDIR:-/tmp}/radiospeak-data-backup.XXXXXX")
chmod 700 "$backup"
mkdir "$backup/data"
was_running=$(docker inspect --format '{{.State.Running}}' "$container_id")
restart_on_failure() {
  result=$?
  if [ "$result" -ne 0 ] && [ "$was_running" = true ]; then
    docker start "$container_id" >/dev/null || true
  fi
  exit "$result"
}
trap restart_on_failure EXIT
docker stop --time 10 "$container_id" >/dev/null
docker cp "$container_id:/data/." "$backup/data"
docker run --rm --entrypoint sh --mount "type=bind,source=$backup/data,target=/backup,readonly" \
  -v "$volume:/target" "$image" -ec 'cp -a /backup/. /target/'
docker run --rm --entrypoint node --mount "type=bind,source=$backup/data,target=/backup,readonly" \
  -v "$volume:/target:ro" "$image" --input-type=module -e '
    import { readdirSync, readFileSync, statSync } from "node:fs";
    import assert from "node:assert/strict";
    function verify(path = "") {
      for (const name of readdirSync("/backup/" + path)) {
        const file = path + name;
        if (statSync("/backup/" + file).isDirectory()) verify(file + "/");
        else assert.deepEqual(readFileSync("/backup/" + file), readFileSync("/target/" + file), file);
      }
    }
    verify();
  '
echo "Data copied and verified. Backup: $backup/data"
echo "Bot is stopped. Deploy the updated compose file now: docker compose up -d --build"
echo "Do not remove the radiospeak-data volume; it contains the bot identity and saved state."
