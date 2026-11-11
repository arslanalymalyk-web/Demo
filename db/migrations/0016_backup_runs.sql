-- A record of base backups, written by the backup script, so the system can tell when backups stop. It holds no institution data: only when a backup ran,
-- whether it worked, how big it was and its checksum. It belongs to the deployment, not to an institution, so it has no institution column and no row-level security.
-- The runtime role can read it and cannot write it; the backup role (for example postgres) writes it.
CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'base' CHECK (kind IN ('base')),
  status text NOT NULL CHECK (status IN ('ok', 'failed')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  label text CHECK (label IS NULL OR length(label) <= 80),
  note text CHECK (note IS NULL OR length(note) <= 300),
  CHECK ((status = 'ok') = (sha256 IS NOT NULL))
);
CREATE INDEX backup_runs_time ON backup_runs (finished_at DESC);
CREATE TRIGGER backup_runs_immutable BEFORE UPDATE OR DELETE ON backup_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
GRANT SELECT ON backup_runs TO tigeris_app;
