#!/usr/bin/env bash
set -euo pipefail

http_port="${REDIS_REST_HTTP_PORT:-8079}"
tls_port="${REDIS_REST_TLS_PORT:-8443}"
token="${UPSTASH_REDIS_REST_TOKEN:-ci-local-redis-token}"
tls_dir="${REDIS_REST_TLS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/axiom-redis-rest-tls}"
container_name="${REDIS_REST_TLS_CONTAINER:-axiom-redis-rest-tls}"

mkdir -p "$tls_dir"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$tls_dir/key.pem" \
  -out "$tls_dir/cert.pem" \
  -days 2 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign"

cat > "$tls_dir/nginx.conf" <<EOF
events {}
http {
  server {
    listen 443 ssl;
    ssl_certificate /etc/nginx/tls/cert.pem;
    ssl_certificate_key /etc/nginx/tls/key.pem;

    location / {
      proxy_pass http://host.docker.internal:${http_port};
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
    }
  }
}
EOF

docker rm --force "$container_name" >/dev/null 2>&1 || true
docker run --detach \
  --name "$container_name" \
  --add-host host.docker.internal:host-gateway \
  --publish "127.0.0.1:${tls_port}:443" \
  --volume "$tls_dir/nginx.conf:/etc/nginx/nginx.conf:ro" \
  --volume "$tls_dir:/etc/nginx/tls:ro" \
  nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 >/dev/null

redis_rest_url="https://127.0.0.1:${tls_port}"
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
    --cacert "$tls_dir/cert.pem" \
    --header "Authorization: Bearer ${token}" \
    --header "Content-Type: application/json" \
    --data '["PING"]' \
    "$redis_rest_url" >/dev/null; then
    if [[ -n "${GITHUB_ENV:-}" ]]; then
      {
        echo "UPSTASH_REDIS_REST_URL=${redis_rest_url}"
        echo "UPSTASH_REDIS_REST_TOKEN=${token}"
        echo "NODE_EXTRA_CA_CERTS=${tls_dir}/cert.pem"
      } >> "$GITHUB_ENV"
    fi
    printf 'Redis REST TLS bridge ready at %s\n' "$redis_rest_url"
    exit 0
  fi
  sleep 1
done

docker logs "$container_name"
printf 'Redis REST TLS bridge did not become ready\n' >&2
exit 1
