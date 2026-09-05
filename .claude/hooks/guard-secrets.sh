#!/usr/bin/env bash
# PreToolUse guard for Bash. Denies commands that would read .env files or
# dump environment variables into the conversation (CLAUDE.md rules 1 and 2).
# Reads the hook JSON on stdin, prints a deny decision when a pattern matches,
# prints nothing (allow) otherwise.
set -u
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# .env, .env.local, .env.production ... but not .env.example / .env.sample / .env.template
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_])\.env(\.[A-Za-z0-9_-]+)?([^A-Za-z0-9_.-]|$)' \
   && ! printf '%s' "$cmd" | grep -Eq '\.env\.(example|sample|template)'; then
  deny "Blocked: command references a .env file (CLAUDE.md rule 2). Secrets never enter the conversation."
fi

# printenv, or a bare `env` that would dump every variable
if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])printenv([[:space:]]|$)' \
   || printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)env[[:space:]]*($|[;&|])'; then
  deny "Blocked: command would print environment variables (CLAUDE.md rule 2)."
fi
exit 0
