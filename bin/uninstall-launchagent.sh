#!/usr/bin/env bash
# Remove the Memo Router timer. The opposite of bin/install-launchagent.sh.
#
# Unloads com.wilmccann.memo-router from launchd and deletes its plist from
# ~/Library/LaunchAgents. Nothing else is touched: the Sheet, the deployment,
# the logs and this checkout stay as they are, and bin/process-memos.sh still
# works by hand. Reinstall with bin/install-launchagent.sh.
#
# Usage:
#   bin/uninstall-launchagent.sh

set -uo pipefail
case "${1:-}" in
  --help|-h) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'; exit 0 ;;
  '') ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-launchagent.sh" --uninstall
