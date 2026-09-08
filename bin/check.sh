#!/usr/bin/env bash
# Everything that can be checked without deploying anything.
#
#   test/receiver-logic.test.mjs   apps-script/Code.gs against a mock Sheet:
#                                  the field mapping in SPEC.md 3.1 and the
#                                  status machine in 3.3, including that an
#                                  unsigned POST appends nothing (case 13's
#                                  logic, though not the real deployment)
#   test/run-fixtures.mjs          the real prompt against the twelve fixture
#                                  memos, every tool switched off
#
# Once the receiver is deployed, test/check-receiver.sh covers what only a real
# deployment can show: the 302 on POST, the scopes, and case 13 for real.
#
# Usage:
#   bin/check.sh              one pass of each
#   bin/check.sh --runs 2     two routing passes, the SPEC.md section 7 bar
#   bin/check.sh --fast       receiver logic only; no model calls, no cost

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

RUNS=1
FAST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="${2:-1}"; shift 2 ;;
    --fast) FAST=1; shift ;;
    --help|-h) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAILED=0

echo "── receiver logic ────────────────────────────────────────────"
node test/receiver-logic.test.mjs || FAILED=1

if [ "$FAST" = "1" ]; then
  echo
  echo "Skipped the routing fixtures (--fast). Run bin/check.sh without it before trusting a prompt change."
  exit "$FAILED"
fi

echo
echo "── routing fixtures ──────────────────────────────────────────"
node test/run-fixtures.mjs --runs "$RUNS" || FAILED=1

echo
if [ "$FAILED" -eq 0 ]; then
  echo "Both suites pass. What is still unproven: the phone app's real body shape,"
  echo "whether it follows the redirect on POST, and the live deployment."
else
  echo "Something failed above."
fi
exit "$FAILED"
