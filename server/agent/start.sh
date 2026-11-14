#!/usr/bin/env bash
# Restores the latest world backup from R2 and starts Minecraft.
set -euo pipefail
set -a; source /etc/mc.env; set +a   # rclone's "r2:" remote is configured there

BACKUPS="r2:mc-world/backups"
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"
WORLD_DIR="$DATA_DIR/world"

# Backup names are UTC timestamps, so the last one alphabetically is the newest
LATEST="$(rclone lsf "$BACKUPS/" | sort | tail -n 1)"
[ -n "$LATEST" ] || { echo "ERROR: no backups in $BACKUPS/" >&2; exit 1; }

ARCHIVE="$(mktemp -p /var/tmp --suffix=.tar.zst)"
trap 'rm -f "$ARCHIVE"' EXIT

echo "Downloading $BACKUPS/$LATEST ..."
rclone copyto "$BACKUPS/$LATEST" "$ARCHIVE"

echo "Checking archive integrity ..."
zstd -tq "$ARCHIVE"

echo "Extracting to $DATA_DIR ..."
mkdir -p "$DATA_DIR"
tar -I zstd -xf "$ARCHIVE" -C "$DATA_DIR"

# Without these Minecraft silently generates a new empty world, so refuse to start
[ -f "$WORLD_DIR/level.dat" ] || { echo "ERROR: missing $WORLD_DIR/level.dat" >&2; exit 1; }
[ -d "$WORLD_DIR/dimensions/minecraft/overworld/region" ] || { echo "ERROR: no overworld chunks in $WORLD_DIR" >&2; exit 1; }

echo "World restored. Starting Minecraft ..."
docker compose -f "$MC_DIR/docker-compose.yml" up -d
