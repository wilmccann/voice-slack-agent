#!/usr/bin/env bash
# One run of the Memo Router. SPEC.md section 4.1.
#
# Called by the LaunchAgent every 4 minutes, and safe to run by hand. Takes a
# lock so two runs never overlap, asks the Sheet whether there is anything to
# do, and only then runs the agent with exactly the tools SPEC.md 5.2 allows
# and appends one line to logs/runs.log.
#
# The precheck is what makes a short timer affordable: it is one small
# HTTPS request through mcp/sheet-server.js --pending, no model call, and it
# writes nothing to the log when the answer is zero. The agent, which costs a
# process start and tokens every time, only launches when a row is waiting.
#
# Rules (CLAUDE.md):
#   2   this script never loads the dotenv file into its own environment. The
#       two MCP servers read their own credentials, so no secret is ever in a
#       variable that a stray echo or a crash dump could print.
#   5   the agent gets five tools and no others: three Sheet tools, one DM tool,
#       one web search. No Bash, no file access, no other MCP server. See the
#       tools section below for the three flags that make that true.
#  11   the log line carries counts and a duration. Never memo text.
#
# Usage:
#   bin/process-memos.sh              one run, quiet unless something is wrong
#   bin/process-memos.sh --verbose    also print the run line and the agent's output
#   bin/process-memos.sh --force      skip the precheck and run the agent regardless
#   bin/process-memos.sh --dry-run    show the command that would run, run nothing

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LOCK_DIR="$ROOT/.run-lock"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/runs.log"
PROMPT_FILE="$ROOT/prompts/process-new-memos.md"
STALE_LOCK_MINUTES=30
MAX_TURNS=40

VERBOSE=0
DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --force|-f) FORCE=1 ;;
    --help|-h) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# launchd gives a job almost no PATH, so find the two binaries explicitly.
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "process-memos: claude is not on PATH; nothing to run" >&2
  exit 127
fi
if ! command -v node >/dev/null 2>&1; then
  echo "process-memos: node is not on PATH; the MCP servers cannot start" >&2
  exit 127
fi
if [ ! -f "$PROMPT_FILE" ]; then
  echo "process-memos: missing $PROMPT_FILE" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

log_line() {
  printf '%s\n' "$1" >>"$LOG_FILE"
  [ "$VERBOSE" = "1" ] && printf '%s\n' "$1"
  return 0
}

# ------------------------------------------------------------------- the lock
# A directory is the lock: mkdir is atomic. A lock older than 30 minutes is left
# over from a run that died, and is taken over.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin "+$STALE_LOCK_MINUTES" 2>/dev/null)" ]; then
    log_line "{\"t\":\"$(date -u +%FT%TZ)\",\"event\":\"stale_lock_taken\"}"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    # A run is already going. This is the normal case when one takes a while.
    [ "$VERBOSE" = "1" ] && echo "another run holds the lock; exiting"
    exit 0
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# --------------------------------------------------------------- the precheck
# One request to the web app's ping action, made by the sheet server so that no
# credential enters this shell (rule 2). It answers with the number of rows a
# claim would take. Zero means exit now, silently: at hundreds of polls a day,
# logging every empty one would bury the lines that matter. A failed check is logged
# once per occurrence and treated as "nothing to do"; the next minute tries
# again, and a row is never lost by waiting.
if [ "$FORCE" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  PENDING="$(node "$ROOT/mcp/sheet-server.js" --pending 2>"$LOG_DIR/last-ping.stderr")"
  PING_STATUS=$?
  if [ "$PING_STATUS" -ne 0 ] || ! [[ "$PENDING" =~ ^[0-9]+$ ]]; then
    log_line "{\"t\":\"$(date -u +%FT%TZ)\",\"event\":\"ping_failed\",\"exit\":$PING_STATUS}"
    [ "$VERBOSE" = "1" ] && echo "precheck failed; see $LOG_DIR/last-ping.stderr" >&2
    exit 0
  fi
  if [ "$PENDING" -eq 0 ]; then
    [ "$VERBOSE" = "1" ] && echo "nothing pending; not launching the agent"
    exit 0
  fi
  [ "$VERBOSE" = "1" ] && echo "$PENDING pending; launching the agent"
fi

# ------------------------------------------------------------------ the tools
# SPEC.md 5.2, exactly. Three things narrow the surface, and all three are
# needed:
#
#   --strict-mcp-config  only the servers in .mcp.json load, so nothing else
#                        configured on this Mac is in reach.
#   --allowedTools       these five run without asking.
#   --disallowedTools    the built-ins are removed from the agent's tool list
#                        altogether. An allowlist alone only governs approval:
#                        Bash and Write would still be offered, and a denied
#                        call would burn a turn. Denying them outright is what
#                        makes "no shell, no file access" true rather than
#                        merely intended.
#
# Verified by asking the agent to list its tools: exactly the five below come
# back.
ALLOWED_TOOLS="mcp__memo-sheet__sheet_read_new,mcp__memo-sheet__sheet_history,mcp__memo-sheet__sheet_update_row,mcp__memo-slack__slack_dm,WebSearch"
DISALLOWED_TOOLS="Bash,Read,Write,Edit,NotebookEdit,WebFetch,Task,Agent,Glob,Grep,Artifact,Skill,Workflow,SendMessage,CronCreate,CronDelete,CronList,Monitor,PushNotification,RemoteTrigger,TaskOutput,TaskStop,EnterWorktree,ExitWorktree,DesignSync,ListAgents,ScheduleWakeup,ToolSearch,ReportFindings"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED="$(date +%s)"

if [ "$DRY_RUN" = "1" ]; then
  echo "would first check:"
  echo "  node mcp/sheet-server.js --pending    (and stop here if it prints 0)"
  echo "then run:"
  echo "  claude -p \"\$(cat prompts/process-new-memos.md)\" \\"
  echo "    --output-format json --max-turns $MAX_TURNS \\"
  echo "    --mcp-config .mcp.json --strict-mcp-config \\"
  echo "    --allowedTools $ALLOWED_TOOLS \\"
  echo "    --disallowedTools $DISALLOWED_TOOLS"
  exit 0
fi

OUTPUT="$(
  "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")" \
    --output-format json \
    --max-turns "$MAX_TURNS" \
    --mcp-config "$ROOT/.mcp.json" \
    --strict-mcp-config \
    --allowedTools "$ALLOWED_TOOLS" \
    --disallowedTools "$DISALLOWED_TOOLS" \
    2>"$LOG_DIR/last-run.stderr" </dev/null
)"
STATUS=$?
ELAPSED=$(( $(date +%s) - STARTED ))

# --------------------------------------------------------------- the log line
# The agent's last line is {"rows":N,"done":N,"asked":N,"errored":N,"skipped":N}. Pull the
# counts out of it, and record nothing else from its output (rule 11).
# total_cost_usd is what the run would have cost at API rates. It is the number
# to look at before deciding whether the agent can move off the subscription
# (SPEC.md 4.3): a week of real memos gives a measured per-memo cost.
counts='{}'
cost='null'
if command -v jq >/dev/null 2>&1; then
  cost="$(printf '%s' "$OUTPUT" | jq -c '.total_cost_usd // null' 2>/dev/null || echo null)"
  [ -z "$cost" ] && cost='null'
  result="$(printf '%s' "$OUTPUT" | jq -r '.result // empty' 2>/dev/null)"
  counts="$(printf '%s' "$result" \
    | grep -o '{[^{}]*"rows"[^{}]*}' | tail -1 \
    | jq -c '{rows,done,asked,errored,skipped}' 2>/dev/null || echo '{}')"
  [ -z "$counts" ] && counts='{}'
fi

LINE="$(
  jq -cn \
    --arg t "$(date -u +%FT%TZ)" \
    --arg run_id "$RUN_ID" \
    --argjson status "$STATUS" \
    --argjson seconds "$ELAPSED" \
    --argjson counts "$counts" \
    --argjson cost "$cost" \
    '{t:$t, run_id:$run_id, exit:$status, seconds:$seconds, cost_usd:$cost} + $counts' 2>/dev/null
)"
[ -z "$LINE" ] && LINE="{\"t\":\"$(date -u +%FT%TZ)\",\"run_id\":\"$RUN_ID\",\"exit\":$STATUS,\"seconds\":$ELAPSED}"
log_line "$LINE"

if [ "$STATUS" -ne 0 ]; then
  echo "process-memos: the agent exited $STATUS; see $LOG_DIR/last-run.stderr" >&2
elif [ "$VERBOSE" = "1" ]; then
  printf '%s\n' "$OUTPUT" | { command -v jq >/dev/null 2>&1 && jq -r '.result // .' || cat; }
fi

exit "$STATUS"
