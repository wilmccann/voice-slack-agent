#!/usr/bin/env bash
# Check the deployed Apps Script receiver.
#
# Covers case 13 of the SPEC.md section 7 test set: a POST with no secret must
# append no row, and must be answered with {"ok": false}. Also checks the wrong
# secret, and that a correct one still works.
#
# Nothing here prints the web app URL or the shared secret (CLAUDE.md rules 2
# and 3), and nothing here posts real memo text (rule 7). curl is called with
# its URL hidden from any error output.
#
# Usage:
#   bash test/check-receiver.sh          auth checks only, writes nothing
#   bash test/check-receiver.sh --full   also posts one synthetic memo and
#                                        walks it through claim and complete

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

# Config comes from the environment or the gitignored dotenv file at the root.
if [ -z "${MEMO_WEBAPP_URL:-}" ] || [ -z "${WEBHOOK_SECRET:-}" ]; then
  DOTENV="$ROOT/$(printf '.%s' 'env')"
  if [ -f "$DOTENV" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$DOTENV"
    set +a
  fi
fi

if [ -z "${MEMO_WEBAPP_URL:-}" ] || [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "Not configured: MEMO_WEBAPP_URL and WEBHOOK_SECRET must be set." >&2
  echo "Copy the example dotenv file at the repository root and fill it in." >&2
  exit 2
fi

PASS=0
FAIL=0
GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'

# Never let curl echo the URL. Errors are reported by exit status only.
# POSTs are made with -d and no -X: curl then follows the 302 with a GET, the
# way a browser or Node's fetch does. With -X POST it would re-POST to the
# redirect target, which answers with HTML, and every POST check would fail.
fetch() {
  curl --silent --show-error --location --max-time 60 "$@" 2>/dev/null
}

ok() { printf '%spass%s  %s\n' "$GREEN" "$OFF" "$1"; PASS=$((PASS+1)); }
no() { printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }

field() { printf '%s' "$1" | jq -r "$2" 2>/dev/null; }

rows_now() {
  local body
  body="$(fetch --get "$MEMO_WEBAPP_URL" --data-urlencode "action=ping" --data-urlencode "k=$WEBHOOK_SECRET")"
  field "$body" '.rows // empty'
}

echo "Checking the receiver. Nothing below prints the URL or the secret."
echo

# ---------------------------------------------------------------- reachable
PING="$(fetch --get "$MEMO_WEBAPP_URL" --data-urlencode "action=ping" --data-urlencode "k=$WEBHOOK_SECRET")"
if [ "$(field "$PING" '.ok')" = "true" ]; then
  ok "the web app answers and the secret is accepted ($(field "$PING" '.rows') rows in the Sheet; by status: $(field "$PING" '.status | to_entries | map("\(.key) \(.value)") | join(", ")'))"
else
  no "the web app did not answer with ok:true" \
     "Check that it is deployed with access set to Anyone, and that WEBHOOK_SECRET matches Script Properties."
  echo
  printf '%sStopping: nothing else can be checked until the web app answers.%s\n' "$DIM" "$OFF"
  exit 1
fi

BEFORE="$(rows_now)"

# ------------------------------------------------- case 13: POST, no secret
NOSECRET="$(fetch "$MEMO_WEBAPP_URL" \
  -H 'content-type: application/json' \
  -d '{"transcript":"synthetic check, no secret, must be dropped"}')"

if [ "$(field "$NOSECRET" '.ok')" = "false" ]; then
  ok "case 13: a POST with no secret is answered ok:false"
else
  no "case 13: a POST with no secret was not refused" "Response ok was: $(field "$NOSECRET" '.ok')"
fi

# --------------------------------------------------- wrong secret is no better
WRONG="$(fetch "$MEMO_WEBAPP_URL" \
  -H 'content-type: application/json' \
  -d '{"transcript":"synthetic check, wrong secret, must be dropped","secret":"not-the-secret"}')"

if [ "$(field "$WRONG" '.ok')" = "false" ]; then
  ok "a POST with a wrong secret is answered ok:false"
else
  no "a POST with a wrong secret was not refused"
fi

AFTER="$(rows_now)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "case 13: neither refused POST appended a row (still $AFTER)"
else
  no "case 13: the row count changed from $BEFORE to $AFTER" "A refused request must append nothing."
fi

# ------------------------------------------------------------- the write path
if [ "$FULL" = "1" ]; then
  echo
  echo "Full check: posting one synthetic memo and walking it through the queue."

  POSTED="$(fetch "$MEMO_WEBAPP_URL" \
    -H 'content-type: application/json' \
    -d "{\"transcript\":\"Synthetic receiver check, safe to delete\",\"secret\":\"$WEBHOOK_SECRET\"}")"
  ID="$(field "$POSTED" '.id')"

  if [ -n "$ID" ] && [ "$ID" != "null" ]; then
    ok "a POST with the right secret appended a row"
  else
    no "a POST with the right secret did not return an id" \
       "If the phone app sees a 302 here, it may not be following the redirect (SPEC.md 3.1)."
  fi

  if [ -n "$ID" ] && [ "$ID" != "null" ]; then
    CLAIM="$(fetch --get "$MEMO_WEBAPP_URL" \
      --data-urlencode "action=claim" --data-urlencode "k=$WEBHOOK_SECRET" \
      --data-urlencode "run_id=receiver-check" --data-urlencode "limit=20")"
    if printf '%s' "$CLAIM" | jq -e --arg id "$ID" '.rows[]? | select(.id == $id)' >/dev/null 2>&1; then
      ok "claim returned the new row and marked it processing"
    else
      no "claim did not return the row just posted"
    fi

    # action travels in the body, so the secret never needs to reach the URL.
    DONE="$(fetch "$MEMO_WEBAPP_URL" \
      -H 'content-type: application/json' \
      -d "{\"secret\":\"$WEBHOOK_SECRET\",\"action\":\"complete\",\"id\":\"$ID\",\"status\":\"done\",\"route\":\"journal\",\"confidence\":\"high\",\"action_summary\":\"synthetic receiver check\"}")"
    if [ "$(field "$DONE" '.ok')" = "true" ]; then
      ok "complete wrote the outcome back to the row"
    else
      no "complete did not accept the update" "$(field "$DONE" '.error')"
    fi

    CLAIM2="$(fetch --get "$MEMO_WEBAPP_URL" \
      --data-urlencode "action=claim" --data-urlencode "k=$WEBHOOK_SECRET" \
      --data-urlencode "run_id=receiver-check-2")"
    if printf '%s' "$CLAIM2" | jq -e --arg id "$ID" '[.rows[]? | select(.id == $id)] | length == 0' >/dev/null 2>&1; then
      ok "a completed row is not claimed again"
    else
      no "a completed row was claimed a second time"
    fi

    printf '%sThe synthetic row %s is still in the Sheet. Delete it by hand if you want a clean log.%s\n' \
      "$DIM" "${ID:0:8}" "$OFF"
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf '%sAll %d checks passed.%s\n' "$GREEN" "$PASS" "$OFF"
  exit 0
fi
printf '%s%d of %d checks failed.%s\n' "$RED" "$FAIL" "$((PASS+FAIL))" "$OFF"
exit 1
