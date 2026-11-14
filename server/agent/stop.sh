#!/usr/bin/env bash
# Stops Minecraft, uploads the world to R2 and keeps only the latest backups.
set -euo pipefail
set -a; source /etc/mc.env; set +a   # rclone's "r2:" remote is configured there

BACKUPS="r2:mc-world/backups"
KEEP=4
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"

# UTC timestamp: sorts chronologically, start.sh relies on that
NAME="$(date --utc +%Y-%m-%dT%H:%M:%SZ).tar.zst"

ARCHIVE="$(mktemp -p /var/tmp --suffix=.tar.zst)"
trap 'rm -f "$ARCHIVE"' EXIT

# A stopped server writes nothing, so the world on disk is consistent
echo "Stopping Minecraft ..."
docker stop mc-server

echo "Archiving world ..."
tar --create --zstd --file "$ARCHIVE" -C "$DATA_DIR" world

echo "Checking archive integrity ..."
zstd -tq "$ARCHIVE"

echo "Uploading to $BACKUPS/$NAME ..."
rclone copyto "$ARCHIVE" "$BACKUPS/$NAME"

# Runs only after a successful upload (set -e), so a good backup is never deleted for a failed one
echo "Removing old backups, keeping the latest $KEEP ..."
rclone lsf "$BACKUPS/" | sort | head -n "-$KEEP" | while read -r OLD; do
    echo "  deleting $OLD"
    rclone deletefile "$BACKUPS/$OLD"
done

echo "Backup done. Safe to delete the server."
