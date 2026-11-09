#!/usr/bin/env bash
# Copia de seguridad de la base de datos. Conserva las de los últimos 14 días.
set -euo pipefail

DEST=/var/backups/capitest
BD=/var/lib/capitest/capitest.db
[ -f "$BD" ] || exit 0
archivo="$DEST/capitest-$(date +%Y%m%d-%H%M%S).db"
sqlite3 "$BD" ".backup '$archivo'"
chown -f capitest:capitest "$BD-wal" "$BD-shm" 2>/dev/null || true
gzip "$archivo"
chmod 600 "$archivo.gz"
find "$DEST" -name 'capitest-*.db.gz' -mtime +14 -delete
