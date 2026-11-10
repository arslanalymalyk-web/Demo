-- Scheduled ingestion. The schedule itself is a governed setting (scope ingestion_schedule); this table holds only the running state.
DO $$
DECLARE n text;
BEGIN
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'settings_versions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%hormuz_exposure%' LOOP
    EXECUTE format('ALTER TABLE settings_versions DROP CONSTRAINT %I', n);
  END LOOP;
END $$;
ALTER TABLE settings_versions ADD CONSTRAINT settings_versions_scope_check CHECK (scope IN ('signal_rules', 'scenario_defaults', 'hormuz_exposure', 'ingestion_schedule'));

ALTER TABLE ingestion_jobs ADD COLUMN trigger text NOT NULL DEFAULT 'command' CHECK (trigger IN ('command', 'manual', 'scheduled'));

CREATE TABLE source_schedule (
  institution_id uuid NOT NULL,
  source_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('catalog', 'series')),
  interval_hours int NOT NULL CHECK (interval_hours BETWEEN 1 AND 8760),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  claimed_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  paused_at timestamptz,
  paused_by uuid,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, source_id),
  FOREIGN KEY (institution_id, source_id) REFERENCES sources (institution_id, id),
  FOREIGN KEY (institution_id, paused_by) REFERENCES principals (institution_id, id)
);
CREATE INDEX source_schedule_due ON source_schedule (next_run_at) WHERE enabled AND NOT paused;

ALTER TABLE source_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_schedule USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON source_schedule TO tigeris_app;
