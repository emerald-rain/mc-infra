#!/usr/bin/env bash
# Stops Minecraft, uploads the world to R2 and keeps only the latest backups.
set -euo pipefail
set -a; source /etc/mc.env; set +a   # rclone's "r2:" remote is configured there

BACKUPS="r2:mc-world/backups"
KEEP=4
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"

# Staged uploads live outside backups/, so the panel never lists an unverified archive.
# They still count toward R2 usage until deleted; a crash or SIGKILL can leave one behind.
PENDING="${BACKUPS%/*}/pending"

# UTC timestamp: sorts chronologically, start.sh relies on that
NAME="$(date --utc +%Y-%m-%dT%H:%M:%SZ).tar.zst"
# Unique staging path: a stale or concurrent run cannot clobber another staged object
STAGED="$PENDING/$$.$RANDOM/$NAME"

ARCHIVE="$(mktemp -p /var/tmp --suffix=.tar.zst)"
UPLOAD_ATTEMPTED=0   # cleanup only after a staged upload was actually started

# Best effort, and only the staged object: the final backup is never deleted here.
cleanup_staged() {
    [ "$UPLOAD_ATTEMPTED" = 1 ] || return 0
    [ -n "$STAGED" ] || return 0
    echo "Removing staged $STAGED ..."
    if rclone deletefile "$STAGED"; then
        echo "Removed staged $STAGED"
    else
        echo "WARNING: could not remove staged $STAGED; it may remain in $PENDING/ and count toward R2 usage" >&2
    fi
    STAGED=""
    UPLOAD_ATTEMPTED=0
}

on_exit() {
    rm -f "$ARCHIVE" || true
    cleanup_staged
}
trap on_exit EXIT

# A stopped server writes nothing, so the world on disk is consistent
echo "Stopping Minecraft ..."
docker stop mc-server > /dev/null
echo "Container mc-server: stopped"

echo "Archiving world ..."
tar --create --zstd --file "$ARCHIVE" -C "$DATA_DIR" world

echo "Checking archive integrity ..."
zstd -tq "$ARCHIVE"

# Skip the post-upload HEAD that may trigger R2's 501; verify the contents below instead.
echo "Uploading $STAGED ..."
UPLOAD_ATTEMPTED=1
if ! rclone copyto --s3-no-head "$ARCHIVE" "$STAGED"; then
    echo "ERROR: uploading the staged backup failed" >&2
    exit 1
fi

echo "Verifying the staged backup ..."
# pipefail: a failed rclone cat fails the check even when cmp sees a matching stream
if ! rclone cat "$STAGED" | cmp -s - "$ARCHIVE"; then
    echo "ERROR: the staged backup does not match $ARCHIVE" >&2
    exit 1
fi

# The timestamp name is unique in practice, but never overwrite a final object:
# an existing one is an older verified backup.
if ! LISTING="$(rclone lsf "$BACKUPS/")"; then
    echo "ERROR: cannot list $BACKUPS/, not publishing" >&2
    exit 1
fi
# Here-string, not a pipe: grep -q exits early and pipefail would turn the writer's SIGPIPE
# into a missed collision.
if grep -Fxq -- "$NAME" <<< "$LISTING"; then
    echo "ERROR: $BACKUPS/$NAME already exists, refusing to overwrite it" >&2
    exit 1
fi

# Same R2 remote, so rclone copies server-side; the staged object was verified above.
# --immutable helps avoid overwriting an existing object, but is not an atomic no-overwrite
# guarantee. A failed copy may still have created the final object; do not delete it here.
echo "Publishing $BACKUPS/$NAME ..."
if ! rclone copyto --immutable "$STAGED" "$BACKUPS/$NAME"; then
    echo "ERROR: publishing $BACKUPS/$NAME failed" >&2
    exit 1
fi

cleanup_staged
echo "Backup uploaded and verified, $(stat -c %s "$ARCHIVE" | awk '{ printf "%.1f GB", $1 / 1e9 }')"

# Runs only after a successful, verified upload (set -e), so a good backup is never deleted for a failed one
echo "Removing old backups, keeping the latest $KEEP ..."
rclone lsf "$BACKUPS/" | sort | head -n "-$KEEP" | while read -r OLD; do
    echo "  deleting $OLD"
    rclone deletefile "$BACKUPS/$OLD"
done

echo "Backup done. Safe to delete the server."
