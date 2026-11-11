# Backup and restore

_Confidential. Property of Tiger Capital AI. Prepared for operators and the client's IT team._

## Policy

- A full base backup every day, plus continuous write-ahead log archiving. Log segments are also switched on a timer (`archive_timeout`), so the recovery point objective is about 5 minutes in normal operation.
- Everything is encrypted before it is stored (openssl AES-256-CBC with pbkdf2), with a SHA-256 manifest. The key comes from the client's secret store and must be at least the required length.
- The two newest base backups and the log still needed by them are kept. Retention of records themselves is ten years and is a separate matter: nothing in the database is auto-deleted.
- Keep a copy of backups away from the database host. Keep the key apart from the backups.

## Monitoring

Each run of `backup.sh` records itself in the database table `backup_runs`: when it ran, whether it worked, its size and checksum, and nothing else. A failed run is recorded too (the script still exits non-zero). The runtime role can read the table and cannot write or change it. The API compares the newest good run with `TIGERIS_BACKUP_MAX_AGE_HOURS` (36 in the compose file, for a daily backup):

- the newest run failed, or the newest good one is older than the limit, or none was ever recorded after the deployment is older than the limit: administrators and auditors get an operations notice (alerts must be configured), Readiness shows "Blocks use", and `tigeris_last_backup_age_hours` and `tigeris_backup_failures_24h` are on `/metrics`;
- a new good run clears it, with a single note.

Schedule the script daily from the host, for example `docker compose exec -T db /opt/tigeris/backup/backup.sh`. The backup role must be allowed to insert into `backup_runs` (the postgres superuser can). If the record cannot be written the backup still succeeds, a warning is printed, and the monitor will say the backup is overdue: that is deliberate, because a backup nobody can see is not proved. This watches that base backups happen. It does not prove they restore: run the drill below.

## Files

`deploy/backup/`: `common.sh`, `archive-wal.sh`, `restore-wal.sh`, `backup.sh`, `restore.sh`, `verify-restore.sh`, `verify-audit.sql`, `postgresql-archive.conf`, `drill-debian.sh`. Settings live in `deploy/compose/backup.env`.

## Take a backup

Run `backup.sh` daily from the host scheduler (see Monitoring). It takes a base backup, encrypts it, writes the manifest and prunes old ones.

## Restore

1. Stop the API. Prepare an empty target directory; the script refuses a non-empty one.
2. Run `restore.sh` with the backup, the key and, for point in time, the target time. It checks the manifest and decrypts and tests the archive before creating anything. A tampered backup, wrong key, short key or a time before any backup is refused.
3. If the backup carries no configuration files the script writes minimal ones and says so. Review them.
4. Start the restored database and run `verify-restore.sh`. It checks the database is up and runs `verify-audit.sql`, which re-computes every institution's audit hash chain.
5. Point the API at the restored database, start it, and check `/ready`.
6. Record the time, target, who ran it and the result.

## Drill results (this build)

`drill-debian.sh` was run on a scratch PostgreSQL cluster using the Debian package layout: base backup, more records written, restore to a chosen moment, chain verified. Restoring to the middle gave exactly the earlier 5 records; the latest gave all 7; each had an intact chain. The five refusal cases listed above were also checked. Four defects were found and fixed during the drill (see the verification report).

**Not yet done:** the same scripts have not been run against the official PostgreSQL container image or in the client's environment. Run the drill there before go-live and after any change to the database image, and repeat it at least every quarter.

The drill (`drill-debian.sh`) also checks the monitoring record on the scratch cluster: a good base backup is recorded with its size and a 64-character checksum, a backup made to fail is recorded as failed and the script still exits non-zero, and the runtime role is refused when it tries to write the record.
