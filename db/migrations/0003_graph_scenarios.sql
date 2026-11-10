-- Graph (entities and typed links) and scenario runs. Link classes are enforced here, not only in application code.

CREATE TYPE entity_kind AS ENUM ('country', 'chokepoint', 'commodity', 'institution', 'facility', 'route', 'mandate', 'portfolio', 'indicator');
CREATE TYPE link_class AS ENUM ('observed', 'sourced', 'inferred', 'assumed', 'sample');

CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  kind entity_kind NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_class data_class NOT NULL DEFAULT 'public_record',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, key),
  UNIQUE (institution_id, id)
);

CREATE TABLE relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  predicate text NOT NULL,
  object_id uuid NOT NULL,
  link_class link_class NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text,
  author text,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, subject_id) REFERENCES entities (institution_id, id),
  FOREIGN KEY (institution_id, object_id) REFERENCES entities (institution_id, id),
  CHECK (subject_id <> object_id),
  CHECK (link_class NOT IN ('assumed', 'inferred', 'sample') OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)),
  UNIQUE (institution_id, id)
);
CREATE INDEX relationships_subject ON relationships (institution_id, subject_id) WHERE status = 'active';
CREATE INDEX relationships_object ON relationships (institution_id, object_id) WHERE status = 'active';

CREATE TABLE relationship_evidence (
  institution_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('supports', 'contradicts', 'context')),
  PRIMARY KEY (institution_id, relationship_id, evidence_id),
  FOREIGN KEY (institution_id, relationship_id) REFERENCES relationships (institution_id, id),
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id)
);

-- Observed and sourced links must cite at least one supporting evidence record by the end of the transaction.
CREATE FUNCTION require_supporting_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.link_class IN ('observed', 'sourced') AND NOT EXISTS (SELECT 1 FROM relationship_evidence WHERE relationship_id = NEW.id AND role = 'supports') THEN
    RAISE EXCEPTION 'a % link needs at least one supporting evidence record', NEW.link_class USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER relationships_need_evidence AFTER INSERT ON relationships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_supporting_evidence();

CREATE TABLE graph_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  content_hash char(64) NOT NULL,
  entity_count int NOT NULL,
  relationship_count int NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, content_hash),
  UNIQUE (institution_id, id)
);

CREATE TABLE scenario_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  template_key text NOT NULL,
  template_version int NOT NULL,
  formula_version text NOT NULL,
  graph_snapshot_id uuid,
  assumptions jsonb NOT NULL,
  inputs jsonb NOT NULL,
  manifest_hash char(64) NOT NULL,
  results_hash char(64) NOT NULL,
  confidence jsonb NOT NULL,
  sensitivity jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, graph_snapshot_id) REFERENCES graph_snapshots (institution_id, id),
  UNIQUE (institution_id, id)
);

CREATE TABLE scenario_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  run_id uuid NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('72h', '90d', '1y', '5y')),
  metric text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  baseline double precision,
  lineage jsonb NOT NULL,
  FOREIGN KEY (institution_id, run_id) REFERENCES scenario_runs (institution_id, id),
  UNIQUE (run_id, horizon, metric)
);

CREATE TRIGGER scenario_runs_immutable BEFORE UPDATE OR DELETE ON scenario_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER scenario_results_immutable BEFORE UPDATE OR DELETE ON scenario_results FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER graph_snapshots_immutable BEFORE UPDATE OR DELETE ON graph_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER relationship_evidence_immutable BEFORE UPDATE OR DELETE ON relationship_evidence FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entities','relationships','relationship_evidence','graph_snapshots','scenario_runs','scenario_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON entities, graph_snapshots, scenario_runs, scenario_results, relationship_evidence TO tigeris_app;
GRANT SELECT, INSERT, UPDATE ON relationships TO tigeris_app;
