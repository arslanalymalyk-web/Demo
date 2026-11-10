-- Foundation schema: institutions, access, sources, evidence, validation, facts, audit.
-- Owner role runs this file. The runtime role gets limited grants at the end.

CREATE TYPE data_class AS ENUM ('public_record', 'third_party_derived', 'licensed_feed', 'institution_own', 'sample_dataset');
CREATE TYPE claim_class AS ENUM ('observed', 'sourced', 'inferred', 'assumed', 'sample');
CREATE TYPE source_status AS ENUM ('approved', 'pending_rights', 'blocked');
CREATE TYPE validation_outcome AS ENUM ('accepted', 'warned', 'quarantined', 'rejected');

CREATE TABLE institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  jurisdiction text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE divisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  name text NOT NULL,
  UNIQUE (institution_id, id)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  key text NOT NULL,
  label text NOT NULL,
  UNIQUE (institution_id, key),
  UNIQUE (institution_id, id)
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  idp_issuer text NOT NULL,
  idp_subject text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, idp_issuer, idp_subject),
  UNIQUE (institution_id, id)
);

CREATE TABLE principal_roles (
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role_id uuid NOT NULL,
  division_id uuid,
  PRIMARY KEY (institution_id, principal_id, role_id),
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, role_id) REFERENCES roles (institution_id, id),
  FOREIGN KEY (institution_id, division_id) REFERENCES divisions (institution_id, id)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  source_key text NOT NULL,
  name text NOT NULL,
  publisher text NOT NULL,
  original_agency text,
  platform_type text NOT NULL,
  base_url text NOT NULL,
  country text,
  status source_status NOT NULL DEFAULT 'pending_rights',
  data_class data_class NOT NULL DEFAULT 'public_record',
  licence_name text,
  licence_url text,
  licence_verified boolean NOT NULL DEFAULT false,
  allowed_purposes text[] NOT NULL DEFAULT ARRAY['analysis'],
  cadence interval NOT NULL DEFAULT interval '1 day',
  freshness_limit interval NOT NULL DEFAULT interval '7 days',
  retention_policy text NOT NULL DEFAULT 'follow_source_licence',
  rights_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, source_key),
  UNIQUE (institution_id, id)
);

CREATE TABLE ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  source_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  FOREIGN KEY (institution_id, source_id) REFERENCES sources (institution_id, id),
  UNIQUE (institution_id, id)
);

CREATE TABLE evidence_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  source_id uuid NOT NULL,
  job_id uuid NOT NULL,
  external_key text NOT NULL,
  original_agency text,
  source_url text,
  event_time timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  raw_hash char(64) NOT NULL,
  version int NOT NULL DEFAULT 1,
  data_class data_class NOT NULL,
  licence_name text,
  transformation text NOT NULL DEFAULT 'none',
  payload jsonb NOT NULL,
  validation_status validation_outcome NOT NULL DEFAULT 'quarantined',
  FOREIGN KEY (institution_id, source_id) REFERENCES sources (institution_id, id),
  FOREIGN KEY (institution_id, job_id) REFERENCES ingestion_jobs (institution_id, id),
  UNIQUE (institution_id, source_id, external_key, raw_hash),
  UNIQUE (institution_id, id)
);
CREATE INDEX evidence_source_time ON evidence_objects (institution_id, source_id, event_time DESC);

CREATE TABLE validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  rules_version text NOT NULL,
  checks jsonb NOT NULL,
  outcome validation_outcome NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id)
);

CREATE TABLE evidence_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  subject text NOT NULL,
  predicate text NOT NULL,
  value jsonb NOT NULL,
  unit text,
  valid_time timestamptz,
  claim_class claim_class NOT NULL DEFAULT 'observed',
  confidence_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_version text NOT NULL,
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id)
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id),
  seq bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  object_type text,
  object_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL,
  UNIQUE (institution_id, seq)
);

-- Hash chain: each event commits to the previous one for the same institution.
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash char(64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.institution_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash FROM audit_events WHERE institution_id = NEW.institution_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.occurred_at := now();
  NEW.hash := encode(digest(NEW.prev_hash || NEW.institution_id::text || NEW.seq::text || NEW.actor_type || COALESCE(NEW.actor_id, '') || NEW.action || COALESCE(NEW.object_type, '') || COALESCE(NEW.object_id, '') || NEW.payload::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain_t BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_chain();

-- Append-only tables: no update or delete, for everyone.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER validation_runs_immutable BEFORE UPDATE OR DELETE ON validation_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER evidence_facts_immutable BEFORE UPDATE OR DELETE ON evidence_facts FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Evidence content is immutable; only its validation status may move forward.
CREATE FUNCTION evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on evidence_objects is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.payload, NEW.raw_hash, NEW.source_id, NEW.external_key, NEW.retrieved_at) IS DISTINCT FROM (OLD.payload, OLD.raw_hash, OLD.source_id, OLD.external_key, OLD.retrieved_at) THEN
    RAISE EXCEPTION 'evidence content is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_guard_t BEFORE UPDATE OR DELETE ON evidence_objects FOR EACH ROW EXECUTE FUNCTION evidence_guard();

-- Row-level security: every institution table, forced, keyed on app.institution_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['divisions','roles','principals','principal_roles','sources','ingestion_jobs','evidence_objects','validation_runs','evidence_facts','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
  ALTER TABLE institutions ENABLE ROW LEVEL SECURITY; ALTER TABLE institutions FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON institutions USING (id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
END $$;

-- Runtime role: no ownership, no bypass, least privilege.
GRANT USAGE ON SCHEMA public TO tigeris_app;
GRANT SELECT ON institutions, divisions, roles, principals, principal_roles TO tigeris_app;
GRANT SELECT, INSERT, UPDATE ON sources TO tigeris_app;
GRANT SELECT, INSERT, UPDATE ON ingestion_jobs TO tigeris_app;
GRANT SELECT, INSERT, UPDATE ON evidence_objects TO tigeris_app;
GRANT SELECT, INSERT ON validation_runs, evidence_facts, audit_events TO tigeris_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO tigeris_app;
