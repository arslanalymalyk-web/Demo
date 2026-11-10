# Backup and restore

_Confidential. Property of Tiger Capital AI. Prepared for operators and the client's IT team._

## Policy

- A full base backup every day, plus continuous write-ahead log archiving. Log segments are also switched on a timer (`archive_timeout`), so the recovery point objective is about 5 minutes in normal operation.
- Everything is encrypted before it is stored (openssl AES-256-CBC with pbkdf2), with a SHA-256 manifest. The key comes from the client's secret store and must be at least the required length.
- The two newest base backups and the log still needed by them are kept. Retention of records themselves is ten years and is a separate matter: nothing in the database is auto-deleted.
- Keep a copy of backups away from the database host. Keep the key apart from the backups.

## Files

`deploy/backup/`: `common.sh`, `archive-wal.sh`, `restore-wal.sh`, `backup.sh`, `restore.sh`, `verify-restore.sh`, `verify-audit.sql`, `postgresql-archive.conf`, `drill-debian.sh`. Settings live in `deploy/compose/backup.env`.

## Take a backup

Run `backup.sh` (the backup service does this daily). It takes a base backup, encrypts it, writes the manifest and prunes old ones.

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
