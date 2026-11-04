#!/usr/bin/env bash
# Restores the latest world backup from R2 and starts the server.
set -euo pipefail

REMOTE="${REMOTE:-r2:mc-world}"
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"
WORLD_DIR="$DATA_DIR/world"

# Backup names are UTC ISO timestamps, so alphabetical order is chronological.
LATEST_BACKUP_NAME="$(rclone lsf "$REMOTE/backups/" | sort | tail -n 1)"
[ -n "$LATEST_BACKUP_NAME" ] || { echo "ERROR: no backups in $REMOTE/backups/" >&2; exit 1; }

ARCHIVE_PATH="$(mktemp --suffix=.tar.zst)"
trap 'rm -f "$ARCHIVE_PATH"' EXIT

echo "Downloading $REMOTE/backups/$LATEST_BACKUP_NAME ..."
rclone copyto "$REMOTE/backups/$LATEST_BACKUP_NAME" "$ARCHIVE_PATH"

echo "Checking archive integrity ..."
zstd -tq "$ARCHIVE_PATH"

mkdir -p "$DATA_DIR"
echo "Extracting to $DATA_DIR ..."
tar -I zstd -xf "$ARCHIVE_PATH" -C "$DATA_DIR"

# Without these Minecraft silently generates a new empty world, so refuse to start.
[ -f "$WORLD_DIR/level.dat" ] || { echo "ERROR: missing $WORLD_DIR/level.dat" >&2; exit 1; }
[ -d "$WORLD_DIR/dimensions/minecraft/overworld/region" ] || { echo "ERROR: no overworld chunks in $WORLD_DIR" >&2; exit 1; }

echo "World restored. Starting server ..."
docker compose -f "$MC_DIR/docker-compose.yml" up -d
