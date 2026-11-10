#!/usr/bin/env bash
# Disaster-recovery drill. Proves that backups restore to a chosen moment with the audit chain intact, and that damaged or
# wrongly keyed backups are refused. SCRATCH ONLY: it creates and then drops a PostgreSQL cluster named "drill" on port 5499.
# Needs root on a Debian or Ubuntu host with the postgresql-16 packages, plus node and the repository dependencies. Run it before
# go-live and after any change to the backup scripts.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BK=/tmp/tigeris-bk; BD=/tmp/drill-backups; KEY=/tmp/drill.key; ENVF=/tmp/drill.env
rm -rf "${BK:?}" "${BD:?}"; mkdir -p $BK $BD; cp "$REPO"/deploy/backup/* $BK/; chmod 755 $BK $BK/*; chown postgres:postgres $BD
openssl rand -base64 48 > $KEY; chmod 644 $KEY
printf 'BACKUP_DIR=%s\nBACKUP_KEY_FILE=%s\n' $BD $KEY > $ENVF; chmod 644 $ENVF
pg_dropcluster --stop 16 drill >/dev/null 2>&1 || true
pg_createcluster 16 drill --port 5499 >/dev/null 2>&1
cat > /etc/postgresql/16/drill/conf.d/archive.conf <<EOF
wal_level = replica
archive_mode = on
archive_command = 'TIGERIS_BACKUP_ENV=$ENVF $BK/archive-wal.sh %p %f'
archive_timeout = 60
EOF
pg_ctlcluster 16 drill start; sleep 3
P="psql -X -q -p 5499 -h /var/run/postgresql"
PS="su postgres -c"
ADMIN='postgresql://postgres@%2Fvar%2Frun%2Fpostgresql:5499/postgres'
cp "$REPO"/scripts/bootstrap-db.sh /tmp/bootstrap-db.sh; chmod 755 /tmp/bootstrap-db.sh
$PS "ADMIN_URL='$ADMIN' DB_PREFIX=drill OWNER_PASSWORD=ownerpw1 APP_PASSWORD=apppw1 bash /tmp/bootstrap-db.sh" >/dev/null 2>&1
(cd "$REPO" && DATABASE_URL_OWNER=postgres://tigeris_owner:ownerpw1@localhost:5499/drill node db/migrate.mjs 2>&1 | tail -3)
INST=11111111-1111-1111-1111-111111111111
ev() { $PS "$P -d drill -c \"BEGIN; SELECT set_config('app.institution_id','$INST',true); INSERT INTO audit_events (institution_id, actor_type, action, payload, prev_hash, hash) VALUES ('$INST','system','$1','{}','',''); COMMIT;\"" >/dev/null; }
$PS "$P -d drill -c \"INSERT INTO institutions (id, name) VALUES ('$INST','Drill')\""
for a in a1 a2 a3; do ev $a; done
$PS "$P -Atc 'SHOW archive_mode; SHOW archive_command; SHOW wal_level'"
echo "== base backup"; $PS "PGPORT=5499 PGHOST=/var/run/postgresql TIGERIS_BACKUP_ENV=$ENVF $BK/backup.sh"
ev b1; ev b2; $PS "$P -d drill -c 'SELECT pg_switch_wal()'" >/dev/null; sleep 2
T=$($PS "$P -d drill -Atc \"SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')\"")+00; echo "recovery point: $T"; sleep 2
ev c1; ev c2; $PS "$P -d drill -c 'SELECT pg_switch_wal()'" >/dev/null; sleep 3
echo "events in the live database: $($PS "$P -d drill -Atc 'SELECT count(*) FROM audit_events'")  (expect 7)"
echo "archived segments: $(ls $BD/wal | wc -l)"; ls $BD/base | head
echo; echo "== restore to the recovery point (expect 5 events: a1 a2 a3 b1 b2)"
R1=/var/lib/postgresql/16/restored1; rm -rf $R1
$PS "TIGERIS_BACKUP_ENV=$ENVF $BK/restore.sh $R1 --time '$T'"
$PS "$BK/verify-restore.sh $R1 drill"
$PS "pg_ctl -D $R1 -o \"-p 55433 -c listen_addresses='' -c unix_socket_directories=/tmp -c archive_mode=off\" -l /tmp/r1.log -w start" >/dev/null 2>&1
echo "events after point-in-time restore: $($PS "psql -X -p 55433 -h /tmp -d drill -Atc \"SELECT string_agg(action, ',' ORDER BY seq) FROM audit_events\"")"
$PS "pg_ctl -D $R1 -m fast stop" >/dev/null 2>&1
echo; echo "== restore to the latest moment (expect 7 events)"
R2=/var/lib/postgresql/16/restored2; rm -rf $R2
$PS "TIGERIS_BACKUP_ENV=$ENVF $BK/restore.sh $R2" && $PS "$BK/verify-restore.sh $R2 drill"
echo; echo "== refusals"
echo -n "non-empty target: "; $PS "TIGERIS_BACKUP_ENV=$ENVF $BK/restore.sh $R2" 2>&1 | tail -1
echo -n "time before any backup: "; $PS "TIGERIS_BACKUP_ENV=$ENVF $BK/restore.sh /var/lib/postgresql/16/r3 --time '2000-01-01 00:00:00+00'" 2>&1 | tail -1
f=$(ls $BD/base/*.tar.gz.enc | head -1); cp $f $f.bak; printf 'X' | dd of=$f bs=1 seek=100 conv=notrunc 2>/dev/null
echo -n "tampered backup: "; $PS "TIGERIS_BACKUP_ENV=$ENVF $BK/restore.sh /var/lib/postgresql/16/r4" 2>&1 | tail -1; mv $f.bak $f; chown postgres:postgres $f
printf 'ENVF_WRONG\n' > /dev/null; openssl rand -base64 48 > /tmp/wrong.key; chmod 644 /tmp/wrong.key; printf 'BACKUP_DIR=%s\nBACKUP_KEY_FILE=/tmp/wrong.key\n' $BD > /tmp/wrong.env; chmod 644 /tmp/wrong.env
echo -n "wrong key: "; $PS "TIGERIS_BACKUP_ENV=/tmp/wrong.env $BK/restore.sh /var/lib/postgresql/16/r5" 2>&1 | tail -2 | tr '\n' ' '; echo
echo -n "short key: "; echo short > /tmp/short.key; chmod 644 /tmp/short.key; printf 'BACKUP_DIR=%s\nBACKUP_KEY_FILE=/tmp/short.key\n' $BD > /tmp/short.env; chmod 644 /tmp/short.env; $PS "TIGERIS_BACKUP_ENV=/tmp/short.env $BK/backup.sh" 2>&1 | tail -1
pg_dropcluster --stop 16 drill >/dev/null 2>&1; rm -rf $R1 $R2 /var/lib/postgresql/16/r3 /var/lib/postgresql/16/r4 /var/lib/postgresql/16/r5 $BK $BD $KEY $ENVF /tmp/wrong.* /tmp/short.* /tmp/bootstrap-db.sh /tmp/r1.log
echo "drill cleaned up"
