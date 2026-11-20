#!/usr/bin/env bash
# Hermetic tests for stop.sh: fake docker, rclone and date; real tar, zstd and cmp.
# No server, Docker daemon or R2 access. Run: bash server/agent/tests/test_stop.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STOP="$HERE/../stop.sh"
NEW_NAME="2026-02-01T00:00:00Z.tar.zst"
OLD_NAMES=(
    2026-01-01T00:00:00Z.tar.zst
    2026-01-02T00:00:00Z.tar.zst
    2026-01-03T00:00:00Z.tar.zst
    2026-01-04T00:00:00Z.tar.zst
)

# Do not inherit mock switches from the caller
unset FAKE_RCLONE_COPY_FAIL FAKE_RCLONE_COPY_PARTIAL FAKE_RCLONE_PUBLISH_FAIL \
      FAKE_RCLONE_PUBLISH_PARTIAL FAKE_RCLONE_LSF_PADDING FAKE_RCLONE_LSF_COUNT \
      FAKE_RCLONE_CAT_MISMATCH FAKE_RCLONE_CAT_TRUNCATE FAKE_RCLONE_CAT_FAIL_AFTER \
      FAKE_RCLONE_DELETE_FAIL FAKE_RCLONE_DELETE_STAGED_FAIL FAKE_DATE

TMP_ROOT="$(mktemp -d -p "${TMPDIR:-/tmp}" stop-test.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/docker" <<'DOCKER_EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${FAKE_DOCKER_LOG:-/dev/null}"
exit 0
DOCKER_EOF

cat > "$BIN/date" <<'DATE_EOF'
#!/usr/bin/env bash
if [ -z "${FAKE_DATE:-}" ]; then
    echo "FAKE_DATE is not set" >&2
    exit 1
fi
printf '%s\n' "$FAKE_DATE"
DATE_EOF

cat > "$BIN/rclone" <<'RCLONE_EOF'
#!/usr/bin/env bash
set -u

LOG="${FAKE_RCLONE_LOG:-/dev/null}"
printf 'rclone %s\n' "$*" >> "$LOG"

cmd="${1:-}"
shift || true

case "$cmd" in
    lsf)
        path="${1:-}"
        dir="${path%/}"
        if [ ! -d "$dir" ]; then
            echo "ERROR: no such directory: $dir" >&2
            exit 3
        fi
        lsf_count=1
        if [ -n "${FAKE_RCLONE_LSF_COUNT:-}" ]; then
            previous=0
            if [ -f "$FAKE_RCLONE_LSF_COUNT" ]; then
                previous="$(cat "$FAKE_RCLONE_LSF_COUNT")"
            fi
            lsf_count=$((previous + 1))
            printf '%s\n' "$lsf_count" > "$FAKE_RCLONE_LSF_COUNT"
        fi
        find "$dir" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort
        if [ "$lsf_count" = 1 ] && [ "${FAKE_RCLONE_LSF_PADDING:-0}" -gt 0 ]; then
            seq 1 "$FAKE_RCLONE_LSF_PADDING" | sed 's/^/padding-/'
        fi
        ;;
    copyto)
        while [ $# -gt 0 ]; do
            case "$1" in
                --s3-no-head|--immutable) shift ;;
                --*) echo "ERROR: unexpected flag: $1" >&2; exit 2 ;;
                *) break ;;
            esac
        done
        src="${1:-}"
        dst="${2:-}"
        if [ -z "$src" ] || [ -z "$dst" ]; then
            echo "ERROR: copyto needs source and destination" >&2
            exit 2
        fi
        is_publish=0
        case "$dst" in
            */backups/*) is_publish=1 ;;
        esac
        if [ "$is_publish" = 1 ] && [ "${FAKE_RCLONE_PUBLISH_PARTIAL:-}" = 1 ]; then
            mkdir -p "$(dirname "$dst")"
            head -c 32 "$src" > "$dst"
            echo "ERROR: simulated partial publish" >&2
            exit 1
        fi
        if [ "$is_publish" = 1 ] && [ "${FAKE_RCLONE_PUBLISH_FAIL:-}" = 1 ]; then
            echo "ERROR: simulated publish failure" >&2
            exit 1
        fi
        if [ "$is_publish" = 0 ] && [ "${FAKE_RCLONE_COPY_FAIL:-}" = 1 ]; then
            if [ "${FAKE_RCLONE_COPY_PARTIAL:-}" = 1 ]; then
                mkdir -p "$(dirname "$dst")"
                head -c 32 "$src" > "$dst"
            fi
            echo "ERROR: simulated upload failure" >&2
            exit 1
        fi
        if [ ! -f "$src" ]; then
            echo "ERROR: no such source: $src" >&2
            exit 3
        fi
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst"
        ;;
    cat)
        path="${1:-}"
        if [ ! -f "$path" ]; then
            echo "ERROR: no such object: $path" >&2
            exit 3
        fi
        if [ "${FAKE_RCLONE_CAT_MISMATCH:-}" = 1 ]; then
            printf 'corrupt\n'
            exit 0
        fi
        if [ "${FAKE_RCLONE_CAT_TRUNCATE:-}" = 1 ]; then
            head -c 16 "$path"
            exit 1
        fi
        cat "$path"
        if [ "${FAKE_RCLONE_CAT_FAIL_AFTER:-}" = 1 ]; then
            exit 1
        fi
        ;;
    deletefile)
        path="${1:-}"
        case "$path" in
            */pending/*)
                if [ "${FAKE_RCLONE_DELETE_STAGED_FAIL:-}" = 1 ]; then
                    echo "ERROR: simulated staged delete failure" >&2
                    exit 1
                fi
                ;;
        esac
        if [ "${FAKE_RCLONE_DELETE_FAIL:-}" = 1 ]; then
            echo "ERROR: simulated delete failure" >&2
            exit 1
        fi
        rm -f "$path"
        ;;
    *)
        echo "ERROR: unsupported rclone command: $cmd" >&2
        exit 2
        ;;
esac
RCLONE_EOF

chmod +x "$BIN/docker" "$BIN/date" "$BIN/rclone"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
not_ok() { FAIL=$((FAIL + 1)); printf 'not ok - %s\n' "$1"; }

assert_eq() {
    local expected="$1" actual="$2" desc="$3"
    if [ "$expected" = "$actual" ]; then ok "$desc"; else not_ok "$desc (expected '$expected', got '$actual')"; fi
}

assert_nonzero() {
    local actual="$1" desc="$2"
    if [ "$actual" -ne 0 ]; then ok "$desc"; else not_ok "$desc (status 0)"; fi
}

assert_file_exists() {
    if [ -f "$1" ]; then ok "$2"; else not_ok "$2 (missing $1)"; fi
}

assert_file_missing() {
    if [ ! -e "$1" ]; then ok "$2"; else not_ok "$2 (exists $1)"; fi
}

assert_file_content() {
    local path="$1" expected="$2" desc="$3"
    if [ -f "$path" ] && [ "$(cat "$path")" = "$expected" ]; then
        ok "$desc"
    else
        not_ok "$desc"
    fi
}

assert_contains() {
    case "$1" in
        *"$2"*) ok "$3" ;;
        *) not_ok "$3 (missing '$2')" ;;
    esac
}

assert_not_contains() {
    case "$1" in
        *"$2"*) not_ok "$3 (found '$2')" ;;
        *) ok "$3" ;;
    esac
}

new_case() {
    CASE="$TMP_ROOT/$1"
    rm -rf "$CASE"
    mkdir -p "$CASE/agent" \
             "$CASE/data/world/region" \
             "$CASE/data/world/dimensions/minecraft/overworld/region" \
             "$CASE/remote/backups" \
             "$CASE/remote/pending" \
             "$CASE/archives"
    printf 'level\n' > "$CASE/data/world/level.dat"
    printf 'region\n' > "$CASE/data/world/region/r.0.0.mca"
    printf 'overworld\n' > "$CASE/data/world/dimensions/minecraft/overworld/region/r.0.0.mca"
    : > "$CASE/mc.env"
    : > "$CASE/rclone.log"
    : > "$CASE/docker.log"

    local name
    for name in "${OLD_NAMES[@]}"; do
        printf 'verified %s\n' "$name" > "$CASE/remote/backups/$name"
    done

    # Tests run a patched copy, so production keeps its real /etc/mc.env and R2 paths
    sed \
        -e "s|source /etc/mc.env|source \"$CASE/mc.env\"|" \
        -e "s|^BACKUPS=\"r2:mc-world/backups\"$|BACKUPS=\"$CASE/remote/backups\"|" \
        -e "s|mktemp -p /var/tmp|mktemp -p \"$CASE/archives\"|" \
        "$STOP" > "$CASE/agent/stop.sh"
    grep -F -- "source \"$CASE/mc.env\"" "$CASE/agent/stop.sh" > /dev/null \
        || { echo "test setup: failed to patch source path" >&2; exit 1; }
    grep -F -- "BACKUPS=\"$CASE/remote/backups\"" "$CASE/agent/stop.sh" > /dev/null \
        || { echo "test setup: failed to patch BACKUPS" >&2; exit 1; }
    grep -F -- "mktemp -p \"$CASE/archives\"" "$CASE/agent/stop.sh" > /dev/null \
        || { echo "test setup: failed to patch ARCHIVE" >&2; exit 1; }
    chmod +x "$CASE/agent/stop.sh"
    bash -n "$CASE/agent/stop.sh"
}

run_stop() {
    local case_dir="$1"
    shift
    set +e
    OUTPUT="$(
        env \
            PATH="$BIN:$PATH" \
            FAKE_RCLONE_LOG="$case_dir/rclone.log" \
            FAKE_DOCKER_LOG="$case_dir/docker.log" \
            FAKE_DATE="${NEW_NAME%.tar.zst}" \
            "$@" \
            bash "$case_dir/agent/stop.sh" 2>&1
    )"
    STATUS=$?
    set -e
}

assert_old_backups_unchanged() {
    local name
    for name in "${OLD_NAMES[@]}"; do
        assert_file_content "$CASE/remote/backups/$name" "verified $name" "old backup $name intact"
    done
}

assert_world_intact() {
    assert_file_content "$CASE/data/world/level.dat" "level" "world level.dat intact"
    assert_file_content "$CASE/data/world/region/r.0.0.mca" "region" "world region intact"
    assert_file_content "$CASE/data/world/dimensions/minecraft/overworld/region/r.0.0.mca" "overworld" "world overworld intact"
}

assert_no_prune_deletes() {
    if grep -F "deletefile $CASE/remote/backups/" "$CASE/rclone.log" > /dev/null; then
        not_ok "no existing backup was deleted"
    else
        ok "no existing backup was deleted"
    fi
}

assert_pending_empty() {
    if [ -z "$(find "$CASE/remote/pending" -type f -print -quit)" ]; then
        ok "staged object removed"
    else
        not_ok "staged object removed"
    fi
}

assert_pending_count() {
    local expected="$1" desc="$2" actual
    actual="$(find "$CASE/remote/pending" -type f -print | wc -l)"
    actual="${actual// /}"
    assert_eq "$expected" "$actual" "$desc"
}

assert_no_backup_publish() {
    if grep -F "copyto" "$CASE/rclone.log" | grep -F " $CASE/remote/backups/" > /dev/null; then
        not_ok "no final object was published"
    else
        ok "no final object was published"
    fi
}

assert_backup_publish() {
    if grep -F "copyto" "$CASE/rclone.log" | grep -F " $CASE/remote/backups/$NEW_NAME" > /dev/null; then
        ok "staged object was published to backups/$NEW_NAME"
    else
        not_ok "staged object was published to backups/$NEW_NAME"
    fi
}

assert_publish_immutable() {
    if grep -F "copyto --immutable" "$CASE/rclone.log" | grep -F " $CASE/remote/backups/$NEW_NAME" > /dev/null; then
        ok "publish used --immutable"
    else
        not_ok "publish used --immutable"
    fi
}

assert_no_final_delete() {
    if grep -F "deletefile $CASE/remote/backups/$NEW_NAME" "$CASE/rclone.log" > /dev/null; then
        not_ok "final object was not deleted"
    else
        ok "final object was not deleted"
    fi
}

assert_no_staged_delete() {
    if grep -F "deletefile" "$CASE/rclone.log" > /dev/null; then
        not_ok "no staged cleanup before upload"
    else
        ok "no staged cleanup before upload"
    fi
}

assert_no_final_cat() {
    if grep -F "cat $CASE/remote/backups/" "$CASE/rclone.log" > /dev/null; then
        not_ok "final object was not read back"
    else
        ok "final object was not read back"
    fi
}

assert_staging_upload_flagged() {
    local line
    line="$(grep -F "copyto --s3-no-head" "$CASE/rclone.log" || true)"
    case "$line" in
        *"$CASE/remote/pending/"*) ok "staged upload used --s3-no-head" ;;
        *) not_ok "staged upload used --s3-no-head" ;;
    esac
}

assert_single_no_head() {
    local count
    count="$(grep -c -F -- '--s3-no-head' "$CASE/rclone.log" || true)"
    assert_eq "1" "$count" "only the staged upload used --s3-no-head"
}

assert_archive_removed() {
    if [ -z "$(find "$CASE/archives" -type f -print -quit)" ]; then
        ok "local archive removed"
    else
        not_ok "local archive removed"
    fi
}

test_success() {
    new_case success
    run_stop "$CASE"

    assert_eq "0" "$STATUS" "success: job exits 0"
    assert_contains "$OUTPUT" "Backup uploaded and verified" "success: success is reported after verification"
    assert_staging_upload_flagged
    assert_single_no_head
    if grep -F "cat $CASE/remote/pending/" "$CASE/rclone.log" > /dev/null; then
        ok "success: staged object was streamed for verification"
    else
        not_ok "success: staged object was streamed for verification"
    fi
    assert_backup_publish
    assert_publish_immutable
    assert_no_final_cat
    assert_file_exists "$CASE/remote/backups/$NEW_NAME" "success: final backup exists"
    if zstd -tq "$CASE/remote/backups/$NEW_NAME" 2> /dev/null; then
        ok "success: published object is a valid archive"
    else
        not_ok "success: published object is a valid archive"
    fi
    assert_file_missing "$CASE/remote/backups/${OLD_NAMES[0]}" "success: oldest backup pruned"
    assert_file_content "$CASE/remote/backups/${OLD_NAMES[1]}" "verified ${OLD_NAMES[1]}" "success: second-oldest backup kept"
    assert_file_content "$CASE/remote/backups/${OLD_NAMES[2]}" "verified ${OLD_NAMES[2]}" "success: third-oldest backup kept"
    assert_file_content "$CASE/remote/backups/${OLD_NAMES[3]}" "verified ${OLD_NAMES[3]}" "success: newest old backup kept"
    assert_pending_empty
    assert_archive_removed
    assert_world_intact

    local save=""
    if [[ "$OUTPUT" =~ Uploading\ [^[:space:]]+/([^[:space:]]+\.tar\.zst) ]]; then
        save="${BASH_REMATCH[1]}"
    fi
    assert_eq "$NEW_NAME" "$save" "success: panel still extracts the final save name"
}

test_mismatch() {
    new_case mismatch
    run_stop "$CASE" FAKE_RCLONE_CAT_MISMATCH=1

    assert_eq "1" "$STATUS" "mismatch: job fails"
    assert_contains "$OUTPUT" "does not match" "mismatch: verification error is reported"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "mismatch: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_archive_removed
    assert_world_intact
}

test_stream_failure() {
    new_case stream_failure
    run_stop "$CASE" FAKE_RCLONE_CAT_TRUNCATE=1

    assert_eq "1" "$STATUS" "stream failure: job fails"
    assert_contains "$OUTPUT" "does not match" "stream failure: verification error is reported"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "stream failure: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_source_stream_pipefail() {
    new_case pipefail
    run_stop "$CASE" FAKE_RCLONE_CAT_FAIL_AFTER=1

    assert_eq "1" "$STATUS" "source stream pipefail: job fails even when cmp sees a matching stream"
    assert_contains "$OUTPUT" "does not match" "source stream pipefail: verification error is reported"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "source stream pipefail: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_upload_failure() {
    new_case upload_failure
    run_stop "$CASE" FAKE_RCLONE_COPY_FAIL=1

    assert_eq "1" "$STATUS" "upload failure: job fails"
    assert_contains "$OUTPUT" "uploading the staged backup failed" "upload failure: upload error is reported"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "upload failure: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_partial_upload_cleanup() {
    new_case partial_upload
    run_stop "$CASE" FAKE_RCLONE_COPY_FAIL=1 FAKE_RCLONE_COPY_PARTIAL=1

    assert_eq "1" "$STATUS" "partial upload: job fails"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "partial upload: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_cleanup_delete_failure() {
    new_case cleanup_delete_failure
    run_stop "$CASE" FAKE_RCLONE_CAT_MISMATCH=1 FAKE_RCLONE_DELETE_STAGED_FAIL=1

    assert_eq "1" "$STATUS" "cleanup delete failure: job fails"
    assert_contains "$OUTPUT" "WARNING: could not remove staged" "cleanup delete failure: warning is printed"
    assert_contains "$OUTPUT" "R2 usage" "cleanup delete failure: retention and cost are called out"
    assert_not_contains "$OUTPUT" "Removed staged" "cleanup delete failure: cleanup is not asserted"
    assert_pending_count "1" "cleanup delete failure: staged object remains"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "cleanup delete failure: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_world_intact
}

test_collision() {
    new_case collision
    # Pretend the clock repeated an existing backup's timestamp
    run_stop "$CASE" FAKE_DATE="${OLD_NAMES[3]%.tar.zst}"

    assert_eq "1" "$STATUS" "collision: job fails instead of overwriting"
    assert_contains "$OUTPUT" "already exists" "collision: overwrite refusal is reported"
    assert_file_content "$CASE/remote/backups/${OLD_NAMES[3]}" "verified ${OLD_NAMES[3]}" "collision: existing backup is unchanged"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_publish_failure() {
    new_case publish_failure
    run_stop "$CASE" FAKE_RCLONE_PUBLISH_FAIL=1

    assert_eq "1" "$STATUS" "publish failure: job fails"
    assert_contains "$OUTPUT" "publishing $CASE/remote/backups/$NEW_NAME failed" "publish failure: publish error is reported"
    assert_file_missing "$CASE/remote/backups/$NEW_NAME" "publish failure: no final backup"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_pending_empty
    assert_world_intact
}

test_success_cleanup_failure() {
    new_case success_cleanup_failure
    run_stop "$CASE" FAKE_RCLONE_DELETE_STAGED_FAIL=1

    assert_eq "0" "$STATUS" "staged cleanup failure after publish: job still succeeds"
    assert_contains "$OUTPUT" "WARNING: could not remove staged" "staged cleanup failure after publish: warning is printed"
    assert_contains "$OUTPUT" "R2 usage" "staged cleanup failure after publish: retention and cost are called out"
    assert_file_exists "$CASE/remote/backups/$NEW_NAME" "staged cleanup failure after publish: final backup exists"
    assert_file_missing "$CASE/remote/backups/${OLD_NAMES[0]}" "staged cleanup failure after publish: pruning still runs"
    assert_pending_count "1" "staged cleanup failure after publish: staged object remains"
    assert_world_intact
}

test_no_data_loss_on_failure() {
    new_case no_data_loss
    run_stop "$CASE" FAKE_RCLONE_CAT_FAIL_AFTER=1

    assert_eq "1" "$STATUS" "no data loss: failed verification fails the job"
    assert_old_backups_unchanged
    assert_world_intact
    assert_no_prune_deletes
    assert_pending_empty
}

test_collision_large_listing() {
    new_case collision_large_listing
    run_stop "$CASE" FAKE_DATE="${OLD_NAMES[3]%.tar.zst}" \
        FAKE_RCLONE_LSF_COUNT="$CASE/lsf.count" FAKE_RCLONE_LSF_PADDING=20000

    assert_eq "1" "$STATUS" "collision with large listing: job fails instead of overwriting"
    assert_contains "$OUTPUT" "already exists" "collision with large listing: overwrite refusal is reported"
    assert_file_content "$CASE/remote/backups/${OLD_NAMES[3]}" "verified ${OLD_NAMES[3]}" "collision with large listing: existing backup is unchanged"
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_no_backup_publish
    assert_pending_empty
    assert_world_intact
}

test_no_cleanup_before_upload() {
    new_case no_cleanup_before_upload
    rm -rf "$CASE/data/world"
    run_stop "$CASE"

    assert_nonzero "$STATUS" "pre-upload failure: job fails"
    assert_no_staged_delete
    assert_no_prune_deletes
    assert_archive_removed
}

test_publish_partial_preserved() {
    new_case publish_partial
    run_stop "$CASE" FAKE_RCLONE_PUBLISH_PARTIAL=1

    assert_eq "1" "$STATUS" "partial publish: job fails"
    assert_contains "$OUTPUT" "publishing $CASE/remote/backups/$NEW_NAME failed" "partial publish: publish error is reported"
    assert_file_exists "$CASE/remote/backups/$NEW_NAME" "partial publish: partial final object is preserved"
    assert_eq "32" "$(stat -c %s "$CASE/remote/backups/$NEW_NAME")" "partial publish: partial final object is not replaced or removed"
    assert_no_final_delete
    assert_old_backups_unchanged
    assert_no_prune_deletes
    assert_pending_empty
    assert_world_intact
}

test_success
test_mismatch
test_stream_failure
test_source_stream_pipefail
test_upload_failure
test_partial_upload_cleanup
test_cleanup_delete_failure
test_collision
test_collision_large_listing
test_publish_failure
test_publish_partial_preserved
test_success_cleanup_failure
test_no_data_loss_on_failure
test_no_cleanup_before_upload

echo
if [ "$FAIL" -ne 0 ]; then
    echo "$FAIL check(s) failed"
    exit 1
fi
echo "All $PASS checks passed"
