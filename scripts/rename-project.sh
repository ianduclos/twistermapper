#!/usr/bin/env bash
# One-shot: rename the project folder (default -> twistermapper), migrate the
# Claude memory dir to match the new path, and reinstall the launchd agent from
# the new location. Run this LAST — your Claude Code session is tied to the old
# path, so reopen it in the new folder afterward.
#
#   bash scripts/rename-project.sh [new-name]
#
# Wrapped in main() so bash reads the whole script before the folder moves out
# from under it.
set -euo pipefail

main() {
	local NEW_NAME="${1:-twistermapper}"
	local LABEL="com.ianduclos.twistermapper"
	local OLD_DIR="/Users/ianduclos/_SecondBrain/01_Projects/twister-manager-2"
	local PARENT NEW_DIR PLIST MEM_BASE OLD_MEM NEW_MEM
	PARENT="$(dirname "$OLD_DIR")"
	NEW_DIR="$PARENT/$NEW_NAME"
	PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
	MEM_BASE="$HOME/.claude/projects"

	# The harness encodes a project path into a memory dir name by replacing
	# every "/" and "_" with "-".
	encode() { echo "$1" | sed 's#/#-#g; s#_#-#g'; }
	OLD_MEM="$MEM_BASE/$(encode "$OLD_DIR")"
	NEW_MEM="$MEM_BASE/$(encode "$NEW_DIR")"

	[ -d "$OLD_DIR" ] || { echo "ERROR: old dir not found: $OLD_DIR"; exit 1; }
	[ -e "$NEW_DIR" ] && { echo "ERROR: target already exists: $NEW_DIR"; exit 1; }

	echo "Stopping agent…"
	launchctl unload "$PLIST" 2>/dev/null || true

	echo "Renaming: $OLD_DIR  ->  $NEW_DIR"
	mv "$OLD_DIR" "$NEW_DIR"

	if [ -d "$OLD_MEM" ] && [ ! -d "$NEW_MEM" ]; then
		echo "Migrating Claude memories -> $NEW_MEM"
		mv "$OLD_MEM" "$NEW_MEM"
	fi

	echo "Reinstalling agent from new path…"
	bash "$NEW_DIR/scripts/agent.sh" install

	echo
	echo "Done. New project dir: $NEW_DIR"
	echo "Next: reopen Claude Code from there  ->  cd \"$NEW_DIR\" && claude"
}

main "$@"
