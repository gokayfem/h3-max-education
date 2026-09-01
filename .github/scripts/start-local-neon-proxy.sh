#!/usr/bin/env bash
set -euo pipefail

proxy_port="${NEON_PROXY_PORT:-4444}"
container_name="${NEON_PROXY_CONTAINER:-axiom-neon-proxy}"
postgres_url="${NEON_PROXY_DATABASE_URL:-postgresql://axiom:axiom@host.docker.internal:5432/axiom}"

# PostgreSQL is already health-checked before this launcher runs. Starting the
# proxy here avoids a service-container race in its one-shot schema bootstrap.
docker rm --force "$container_name" >/dev/null 2>&1 || true
docker run --detach \
  --name "$container_name" \
  --add-host host.docker.internal:host-gateway \
  --publish "127.0.0.1:${proxy_port}:4444" \
  --env "PG_CONNECTION_STRING=${postgres_url}" \
  ghcr.io/timowilhelm/local-neon-http-proxy:main@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a >/dev/null

for attempt in $(seq 1 30); do
  if curl --silent --output /dev/null "http://127.0.0.1:${proxy_port}/"; then
    printf 'Local Neon proxy ready at http://127.0.0.1:%s\n' "$proxy_port"
    exit 0
  fi
  sleep 1
done

docker logs "$container_name"
printf 'Local Neon proxy did not become ready\n' >&2
exit 1
