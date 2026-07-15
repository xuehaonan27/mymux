#!/usr/bin/env bash
# Install the mymux agent-status plugin for Open Code:
# copies scripts/opencode-mymux-plugin.js to ~/.config/opencode/plugins/mymux.js
# (plugins in that directory are auto-loaded at startup; idempotent overwrite —
# the file is pure data, no merge needed).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
mkdir -p "$DEST_DIR"
cp "$DIR/opencode-mymux-plugin.js" "$DEST_DIR/mymux.js"
echo "mymux: installed Open Code plugin → $DEST_DIR/mymux.js"
echo "Events: permission.asked→waiting, session.idle→done (running via mymuxd's heuristic)"
echo "Done. Restart opencode inside a mymux pane to pick it up."
