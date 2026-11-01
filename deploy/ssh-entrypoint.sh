#!/bin/sh
# SSH authorized_keys forces this command; no arbitrary remote command is run.
set -eu
if [ "${SSH_ORIGINAL_COMMAND:-}" != "deploy" ]; then
  echo 'Only the deploy command is permitted' >&2
  exit 64
fi
exec /usr/bin/sudo -n /usr/local/sbin/alidjone-receive-release
