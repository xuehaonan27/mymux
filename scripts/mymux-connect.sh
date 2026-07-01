#!/usr/bin/env bash
# Resilient tunnel to a remote mymuxd — the no-build equivalent of the
# `mymux-connect` binary. Enter your ssh passphrase once (ssh-agent/keychain);
# the forward auto-reconnects on network drops. The remote tmux + mymuxd keep
# your sessions; the browser UI re-syncs on reconnect.
#
# Usage: scripts/mymux-connect.sh <ssh-host> [local-port] [remote-port]
set -u
HOST="${1:?usage: mymux-connect.sh <ssh-host> [local-port] [remote-port]}"
LOCAL="${2:-8088}"
REMOTE="${3:-8088}"

echo "mymux-connect: localhost:$LOCAL -> $HOST:$REMOTE  (Ctrl-C to stop)"
echo "then open the UI against localhost:$LOCAL"

backoff=1
while true; do
  start=$(date +%s)
  ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ControlMaster=auto -o 'ControlPath=~/.ssh/mymux-%r@%h:%p' -o ControlPersist=60 \
    -L "$LOCAL:localhost:$REMOTE" "$HOST"
  ran=$(( $(date +%s) - start ))
  [ "$ran" -ge 10 ] && backoff=1
  echo "mymux-connect: link dropped; reconnecting in ${backoff}s"
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
