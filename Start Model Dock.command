#!/bin/zsh
set -e

cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print -u2 'Model Dock requires Node.js 22.12 or later.'
  exit 1
fi

exec node apps/gateway/cli.mjs serve --reuse
