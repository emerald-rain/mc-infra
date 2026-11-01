#!/usr/bin/env bash
# Восстанавливает мир из хранилища перед запуском сервера.
# Использование: ./restore.sh && docker compose up -d
set -euo pipefail

# Где лежит мир. Сейчас — локальная папка вместо R2; потом станет "r2:mc-world".
REMOTE="${REMOTE:-r2:$HOME/fake-r2/mc-world}"

# Папка minecraft/ (на уровень выше scripts/), чтобы скрипт работал из любой текущей папки.
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$MC_DIR/data"
ARCHIVE="$(mktemp --suffix=.tar.zst)"
trap 'rm -f "$ARCHIVE"' EXIT

echo "Скачиваю $REMOTE/current/world.tar.zst ..."
rclone copyto "$REMOTE/current/world.tar.zst" "$ARCHIVE"

echo "Проверяю целостность архива ..."
zstd -tq "$ARCHIVE"

mkdir -p "$DATA_DIR"
echo "Распаковываю в $DATA_DIR ..."
tar -I zstd -xf "$ARCHIVE" -C "$DATA_DIR"

# Без этих файлов Minecraft молча создаст новый пустой мир — не запускаемся.
WORLD="$DATA_DIR/world"
[ -f "$WORLD/level.dat" ] || { echo "ОШИБКА: нет $WORLD/level.dat" >&2; exit 1; }
[ -d "$WORLD/dimensions/minecraft/overworld/region" ] || { echo "ОШИБКА: нет чанков overworld в $WORLD" >&2; exit 1; }

echo "Мир восстановлен."
