-- Giving someone the administrator or approver role needs a second administrator. The request, who asked and who decided are kept.
CREATE TABLE role_grant_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  principal_id uuid NOT NULL,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid,
  decided_at timestamptz,
  note text,
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, requested_by) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, decided_by) REFERENCES principals (institution_id, id),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);
CREATE INDEX role_grant_requests_open ON role_grant_requests (institution_id, requested_at DESC) WHERE status = 'pending';
ALTER TABLE role_grant_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grant_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_grant_requests USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON role_grant_requests TO tigeris_app;
