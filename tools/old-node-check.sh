#!/bin/sh
# Proves that a Node.js too old for the project stops every npm command with the reason.
#
#   tools/old-node-check.sh [image]        image defaults to node:20-slim
#
# The tests cannot show this, because they run on a version the project accepts. This runs every
# script named in package.json, and `npm install`, on the image's Node.js, in a container, on a copy
# of this checkout. Each has to exit non-zero and say which version it found.
#
# Exit 0: every command stopped that way. Exit 1: one did not. Exit 2: the check could not run.
# It needs Docker, and the network for the image and for `npm install`.
set -eu

image="${1:-node:20-slim}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "old-node-check: Docker is not running, so nothing was checked." >&2
  exit 2
fi

status=0
docker run --rm -e NPM_CONFIG_UPDATE_NOTIFIER=false -e IMAGE="$image" -v "$root":/src:ro "$image" sh -c '
  found="$(node -p process.versions.node)"
  if node /src/tools/check-node.cjs >/dev/null 2>&1; then
    echo "old-node-check: $IMAGE holds Node.js $found, which the project accepts, so it shows nothing about an older one." >&2
    exit 2
  fi
  mkdir /app && cd /src && tar cf - --exclude=./node_modules --exclude=./.git --exclude=./wt . | (cd /app && tar xf -) && cd /app || exit 2

  count=0
  failed=0
  stopped() {
    count=$((count + 1))
    code=0
    out="$("$@" 2>&1)" || code=$?
    if [ "$code" -ne 0 ] && printf "%s" "$out" | grep -q "and this is Node.js $found"; then
      echo "stopped, naming Node.js $found:  $*"
    else
      echo "NOT STOPPED (exit $code):  $*"
      printf "%s\n" "$out" | tail -6
      failed=1
    fi
  }
  for name in $(node -p "Object.keys(require(\"./package.json\").scripts).join(\" \")"); do
    stopped npm run "$name"
  done
  stopped npm install

  if [ "$count" -lt 2 ]; then
    echo "old-node-check: package.json names no script, so nothing was checked." >&2
    exit 2
  fi
  echo "old-node-check: $count command(s) on Node.js $found"
  exit "$failed"
' || status=$?

case "${status}" in
  0) exit 0 ;;
  1) echo "old-node-check: a command above ran, or failed without the reason, on a Node.js the project does not accept." >&2; exit 1 ;;
  *) echo "old-node-check: the check could not run (exit ${status}), so nothing can be concluded." >&2; exit 2 ;;
esac
