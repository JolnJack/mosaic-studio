#!/bin/zsh -l
set -e
mosaic_root="${0:A:h}"
cd "$mosaic_root"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22.13 or newer first.'
  read '?Press Enter to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund
fi
echo 'Open http://127.0.0.1:4173/app in your browser.'
echo 'Press Control-C here to stop the local server.'
exec node --env-file=.env.example --env-file-if-exists=.env server.mjs
