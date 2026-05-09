#!/bin/bash
set -e

cd "$(dirname "$0")"

case "${1:-}" in
  backend)
    unset OPENCODE_SERVER_PASSWORD
    bun --conditions=browser packages/opencode/src/index.ts serve --port 4097
    ;;
  frontend)
    VITE_OPENCODE_SERVER_PORT=4097 bun --cwd packages/app dev
    ;;
  *)
    echo "Usage: ./dev.sh <backend|frontend>"
    exit 1
    ;;
esac
