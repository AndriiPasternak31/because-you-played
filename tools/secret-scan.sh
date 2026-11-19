#!/bin/sh
# Scans the commits this branch adds for secrets. Findings are shown redacted.
#
#   tools/secret-scan.sh [base-ref]        base-ref defaults to main
#
# Exit 0: no finding. Exit 1: a finding; do not push. Exit 2: the scan could not run.
# It reads committed history only. A file that is not committed is not scanned.
set -eu

base="${1:-main}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "secret-scan: gitleaks is not installed, so nothing was scanned. Install it; do not skip this." >&2
  exit 2
fi
if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "secret-scan: base ref '${base}' does not exist, so there is no range to scan." >&2
  exit 2
fi

count="$(git rev-list --count "${base}..HEAD")"
echo "secret-scan: ${count} commit(s) in ${base}..HEAD"

status=0
gitleaks git --redact --verbose --no-banner --no-color --exit-code 99 --log-opts="${base}..HEAD" . || status=$?
case "${status}" in
  0) exit 0 ;;
  99) echo "secret-scan: finding(s) above. Remove the secret from history and rotate it; do not push." >&2; exit 1 ;;
  *) echo "secret-scan: gitleaks failed with exit ${status}, so nothing can be concluded." >&2; exit 2 ;;
esac
