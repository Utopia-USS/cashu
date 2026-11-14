#!/bin/sh
# Serves the design/ mockup tree on http://localhost:8600 (pass --port N to change).
set -e
exec node "$(dirname "$0")/tool/serve.mjs" "$@"
