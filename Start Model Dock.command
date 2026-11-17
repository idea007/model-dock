#!/bin/zsh
set -e

cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print -u2 'Model Dock requires Node.js 22.12 or later.'
  exit 1
fi

cli=apps/gateway/cli.mjs
port=${MODEL_DOCK_PORT:-4317}
lock=${MODEL_DOCK_HOME:-$HOME/.model-dock}/server.lock
gateway_pid=$(node -e '
  const fs = require("node:fs");
  try {
    const { pid } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) console.log(pid);
  } catch {}
' "$lock")

# Reuse the listener only when it belongs to the gateway for this data directory.
if [[ -n "$gateway_pid" ]] &&
    /usr/sbin/lsof -nP -a -p "$gateway_pid" -iTCP -sTCP:LISTEN -Fn |
    /usr/bin/grep -Fxq "n127.0.0.1:$port"; then
  exec node "$cli" open
fi

exec node "$cli" serve
