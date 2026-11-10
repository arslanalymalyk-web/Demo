# Shared settings for the backup scripts. Sourced, not run.
# BACKUP_DIR      where encrypted base backups (base/) and archived log segments (wal/) are kept. Use a different disk or host from the database.
# BACKUP_KEY_FILE a file holding a long random passphrase: openssl rand -base64 48 > key && chmod 600 key. Keep a copy in the client's own safe. Without it, no backup can be read.
# KEEP_DAYS       base backups older than this are pruned, always keeping the newest two (default 14).
ENV_FILE="${TIGERIS_BACKUP_ENV:-/etc/tigeris/backup.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${BACKUP_DIR:?BACKUP_DIR is not set (see $ENV_FILE)}" "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is not set}"
[ -r "$BACKUP_KEY_FILE" ] || { echo "cannot read BACKUP_KEY_FILE" >&2; exit 2; }
[ "$(wc -c < "$BACKUP_KEY_FILE")" -ge 32 ] || { echo "BACKUP_KEY_FILE is too short: use at least 32 characters" >&2; exit 2; }
KEEP_DAYS="${KEEP_DAYS:-14}"
umask 077
ENC=(openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY_FILE")
