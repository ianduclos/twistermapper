#!/usr/bin/env bash
# Manage the twistermapper launchd agent (macOS).
#   ./scripts/agent.sh install     install + load (auto-starts at login, KeepAlive)
#   ./scripts/agent.sh uninstall   unload + remove the plist
#   ./scripts/agent.sh start        load (start)            — use after `stop`
#   ./scripts/agent.sh stop         unload (stop) for dev   — frees the MIDI port
#   ./scripts/agent.sh status       is it loaded?
#   ./scripts/agent.sh logs         tail the log
#
# Why stop for dev: the agent holds the MIDI/OSC ports and the single-instance
# lock, so `npm run dev` will exit ("Already running") until you `stop` the agent.
set -euo pipefail

LABEL="com.ianduclos.twistermapper"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/twistermapper.log"

case "${1:-}" in
	install)
		NODE_BIN="$(command -v node)"
		ENTRY="$PROJECT_DIR/dist/cli/index.js"
		[ -f "$ENTRY" ] || (cd "$PROJECT_DIR" && npm run build)
		mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
		sed -e "s|@LABEL@|$LABEL|g" \
			-e "s|@NODE@|$NODE_BIN|g" \
			-e "s|@ENTRY@|$ENTRY|g" \
			-e "s|@WORKDIR@|$PROJECT_DIR|g" \
			-e "s|@LOG@|$LOG|g" \
			"$PROJECT_DIR/scripts/twistermapper.plist.template" > "$PLIST"
		launchctl unload "$PLIST" 2>/dev/null || true
		launchctl load "$PLIST"
		echo "Installed + loaded $LABEL"
		echo "  node:  $NODE_BIN"
		echo "  entry: $ENTRY"
		echo "  log:   $LOG"
		echo "  UI:    http://localhost:57190"
		;;
	uninstall)
		launchctl unload "$PLIST" 2>/dev/null || true
		rm -f "$PLIST"
		echo "Uninstalled $LABEL"
		;;
	start)
		launchctl load "$PLIST"
		echo "Started $LABEL"
		;;
	stop)
		launchctl unload "$PLIST"
		echo "Stopped $LABEL (unloaded; re-run 'start' to resume)"
		;;
	status)
		if launchctl list | grep -q "$LABEL"; then
			launchctl list | grep "$LABEL"
		else
			echo "$LABEL is not loaded"
		fi
		;;
	logs)
		tail -n 40 -f "$LOG"
		;;
	*)
		echo "usage: $0 {install|uninstall|start|stop|status|logs}"
		exit 1
		;;
esac
