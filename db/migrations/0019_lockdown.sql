-- The institution's emergency stop. While it is on, the application refuses everything except what administrators and auditors need to investigate and to switch it off again.
CREATE TABLE institution_controls (
  institution_id uuid PRIMARY KEY REFERENCES institutions(id),
  lockdown boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE institution_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON institution_controls USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON institution_controls TO tigeris_app;
