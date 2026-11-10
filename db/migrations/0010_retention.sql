-- Retention: legal holds on cases, and a record of every export. Nothing in the system deletes records; these tables exist so
-- that any future deletion tool, and every reviewer, can see what is protected and what has left the system.
CREATE TABLE retention_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  case_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 10),
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  release_reason text,
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, placed_by) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, released_by) REFERENCES principals (institution_id, id),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE UNIQUE INDEX one_active_hold ON retention_holds (institution_id, case_id) WHERE released_at IS NULL;

CREATE TABLE record_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('case')),
  subject_id uuid NOT NULL,
  exported_by uuid NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now(),
  sha256 char(64) NOT NULL,
  bytes int NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) >= 10),
  FOREIGN KEY (institution_id, exported_by) REFERENCES principals (institution_id, id)
);

CREATE FUNCTION holds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on retention_holds is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.case_id, NEW.reason, NEW.placed_by, NEW.placed_at) IS DISTINCT FROM (OLD.case_id, OLD.reason, OLD.placed_by, OLD.placed_at)
  THEN RAISE EXCEPTION 'a hold cannot be rewritten; release it and place a new one' USING ERRCODE = '55000'; END IF;
  IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'a released hold cannot change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER holds_guard_t BEFORE UPDATE OR DELETE ON retention_holds FOR EACH ROW EXECUTE FUNCTION holds_guard();
CREATE TRIGGER record_exports_immutable BEFORE UPDATE OR DELETE ON record_exports FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_holds', 'record_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON retention_holds TO tigeris_app;
GRANT SELECT, INSERT ON record_exports TO tigeris_app;
