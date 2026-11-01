#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_HOST:?Set DEPLOY_HOST}"
: "${DEPLOY_USER:?Set DEPLOY_USER}"
: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Set DEPLOY_KNOWN_HOSTS}"
: "${EXPECTED_REVISION:?Set EXPECTED_REVISION}"
archive=${1:-release.tar.gz}
[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "$DEPLOY_USER" =~ ^[a-zA-Z0-9_-]+$ ]]
key_directory=$(mktemp -d)
trap 'rm -rf -- "$key_directory"' EXIT
chmod 700 "$key_directory"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_directory/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$key_directory/known_hosts"
chmod 600 "$key_directory/key" "$key_directory/known_hosts"
ssh -T -i "$key_directory/key" \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$key_directory/known_hosts" \
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
  "$DEPLOY_USER@$DEPLOY_HOST" deploy < "$archive"
# Check the public HTTPS route and the exact commit, not merely HTTP 200.
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 10 \
      https://alijhone.store/healthz > "$key_directory/health.json" && \
    node --input-type=module - "$key_directory/health.json" <<'NODE'
import { readFileSync } from 'node:fs';
const health = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (health.ok !== true || health.revision !== process.env.EXPECTED_REVISION) process.exit(1);
console.log('Production healthy at revision ' + health.revision);
NODE
  then
    exit 0
  fi
  sleep 2
done
echo 'Public HTTPS/revision check failed' >&2
exit 1
