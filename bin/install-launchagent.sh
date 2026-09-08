#!/usr/bin/env bash
# Install, remove or inspect the Memo Router timer. SPEC.md section 4.1, step 5
# of the build order.
#
# Fills the placeholders in launchd/com.wilmccann.memo-router.plist.template
# with this checkout's real paths and loads the result. Nothing is installed
# until you run this, and installing does not fire a run: the first one happens
# one interval later.
#
# Usage:
#   bin/install-launchagent.sh                 install at the default, every 4 minutes
#   bin/install-launchagent.sh --interval 60   once a minute instead
#   bin/install-launchagent.sh --status        is it loaded, and when did it last run
#   bin/install-launchagent.sh --uninstall     unload and delete it (or bin/uninstall-launchagent.sh)
#
# A short interval is affordable because bin/process-memos.sh checks the Sheet
# with one small request first and only launches the agent when a row is
# waiting. At 4 minutes a memo is typically picked up within two minutes of
# landing, and the check runs 360 times a day.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.wilmccann.memo-router"
TEMPLATE="$ROOT/launchd/$LABEL.plist.template"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL=240
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    --status) MODE="status"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --help|-h) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

UID_NUM="$(id -u)"

case "$MODE" in

status)
  if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    echo "loaded: yes"
    launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null \
      | grep -E '^\s+(state|last exit code|runs) ' | sed 's/^[[:space:]]*/  /'
  else
    echo "loaded: no"
  fi
  if [ -f "$ROOT/logs/runs.log" ]; then
    echo "last runs:"
    tail -5 "$ROOT/logs/runs.log" | sed 's/^/  /'
  else
    echo "last runs: none yet (logs/runs.log does not exist)"
  fi
  exit 0
  ;;

uninstall)
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null \
    || launchctl unload "$TARGET" 2>/dev/null
  rm -f "$TARGET"
  echo "Removed $LABEL. The agent will not run again until you reinstall it."
  echo "Nothing else was touched: the Sheet, the deployment and the logs are as they were."
  exit 0
  ;;

install)
  [ -f "$TEMPLATE" ] || { echo "Missing $TEMPLATE" >&2; exit 1; }
  case "$INTERVAL" in
    ''|*[!0-9]*) echo "--interval takes seconds, as a number." >&2; exit 2 ;;
  esac
  [ "$INTERVAL" -lt 60 ] && { echo "An interval under 60 seconds is not sensible here." >&2; exit 2; }

  # The job needs to find claude and node; launchd starts with almost no PATH.
  JOB_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  for tool in claude node; do
    if ! PATH="$JOB_PATH" command -v "$tool" >/dev/null 2>&1; then
      found="$(command -v "$tool" 2>/dev/null)"
      if [ -n "$found" ]; then
        JOB_PATH="$(dirname "$found"):$JOB_PATH"
      else
        echo "Cannot find $tool anywhere on PATH. Install it before the timer will work." >&2
        exit 1
      fi
    fi
  done

  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__PATH__|$JOB_PATH|g" \
      -e "s|__INTERVAL__|$INTERVAL|g" \
      "$TEMPLATE" >"$TARGET"

  if ! plutil -lint "$TARGET" >/dev/null 2>&1; then
    echo "The generated plist is not valid; leaving it at $TARGET for inspection." >&2
    exit 1
  fi

  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
  if launchctl bootstrap "gui/$UID_NUM" "$TARGET" 2>/dev/null \
     || launchctl load "$TARGET" 2>/dev/null; then
    if [ "$INTERVAL" -lt 120 ]; then
      echo "Installed $LABEL, checking every $INTERVAL seconds."
    else
      echo "Installed $LABEL, checking every $((INTERVAL / 60)) minutes."
    fi
    echo "Each check is one request to the Sheet; the agent only runs when a row is waiting."
    echo
    echo "It will not fire immediately. To see a run now:"
    echo "  bin/process-memos.sh --verbose"
    echo
    echo "To check on it later:"
    echo "  bin/install-launchagent.sh --status"
  else
    echo "Wrote $TARGET but launchctl would not load it." >&2
    exit 1
  fi
  ;;

esac
