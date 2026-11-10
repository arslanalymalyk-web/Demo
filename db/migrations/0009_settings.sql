-- Governed settings: versioned, drafted by one administrator and activated by another. A version never changes once written.
CREATE TABLE settings_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  scope text NOT NULL CHECK (scope IN ('signal_rules', 'scenario_defaults', 'hormuz_exposure')),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  payload jsonb NOT NULL,
  note text NOT NULL CHECK (length(note) >= 10),
  created_by text NOT NULL,
  activated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (institution_id, scope, version),
  UNIQUE (institution_id, id)
);
CREATE UNIQUE INDEX one_active_setting ON settings_versions (institution_id, scope) WHERE status = 'active';

CREATE FUNCTION settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on settings_versions is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.scope, NEW.version, NEW.payload, NEW.note, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.scope, OLD.version, OLD.payload, OLD.note, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'a settings version is immutable; create a new version' USING ERRCODE = '55000'; END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('draft', 'active')) OR (OLD.status = 'active' AND NEW.status IN ('active', 'retired')) OR (OLD.status = 'retired' AND NEW.status = 'retired'))
  THEN RAISE EXCEPTION 'invalid settings status change % to %', OLD.status, NEW.status USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settings_guard_t BEFORE UPDATE OR DELETE ON settings_versions FOR EACH ROW EXECUTE FUNCTION settings_guard();

ALTER TABLE settings_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settings_versions USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON settings_versions TO tigeris_app;
