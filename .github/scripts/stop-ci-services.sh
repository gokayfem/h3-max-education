#!/usr/bin/env bash
set -euo pipefail

docker rm --force \
  "${NEON_PROXY_CONTAINER:-axiom-neon-proxy}" \
  "${REDIS_REST_TLS_CONTAINER:-axiom-redis-rest-tls}" \
  >/dev/null 2>&1 || true

rm -rf "${REDIS_REST_TLS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/axiom-redis-rest-tls}"
