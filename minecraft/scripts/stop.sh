#!/usr/bin/env bash
# Stops the server, uploads the world to R2 and keeps only the latest backups.
set -euo pipefail

KEEP_BACKUPS=4

REMOTE="${REMOTE:-r2:mc-world}"
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"

# UTC ISO timestamp: sorts chronologically, start.sh relies on that.
TIMESTAMP="$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
BACKUP_NAME="$TIMESTAMP.tar.zst"

ARCHIVE_PATH="$(mktemp --suffix=.tar.zst)"
trap 'rm -f "$ARCHIVE_PATH"' EXIT

# A stopped server writes nothing, so the world on disk is consistent.
echo "Stopping server ..."
docker stop mc-server

echo "Archiving world ..."
tar --create --zstd --file "$ARCHIVE_PATH" -C "$DATA_DIR" world

echo "Checking archive integrity ..."
zstd -tq "$ARCHIVE_PATH"

echo "Uploading to $REMOTE/backups/$BACKUP_NAME ..."
rclone copyto "$ARCHIVE_PATH" "$REMOTE/backups/$BACKUP_NAME"

# Runs only after a successful upload (set -e), so a good backup is never deleted for a failed one.
echo "Removing old backups, keeping the latest $KEEP_BACKUPS ..."
rclone lsf "$REMOTE/backups/" | sort | head -n "-$KEEP_BACKUPS" | while read -r OLD_BACKUP_NAME; do
    echo "  deleting $OLD_BACKUP_NAME"
    rclone deletefile "$REMOTE/backups/$OLD_BACKUP_NAME"
done

echo "Backup done. Safe to delete the server."
