-- Time series of observations. Each point is an immutable fact tied to the evidence snapshot it came from.
CREATE TABLE series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  source_id uuid NOT NULL,
  series_key text NOT NULL,
  title text NOT NULL,
  description text,
  frequency text NOT NULL,
  packs text[] NOT NULL DEFAULT '{}',
  max_age_days int,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, source_id) REFERENCES sources (institution_id, id),
  UNIQUE (institution_id, series_key),
  UNIQUE (institution_id, id)
);
ALTER TABLE series ENABLE ROW LEVEL SECURITY;
ALTER TABLE series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON series USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON series TO tigeris_app;

ALTER TABLE evidence_facts
  ADD COLUMN series_id uuid,
  ADD COLUMN dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN unit_stated boolean NOT NULL DEFAULT true,
  ADD FOREIGN KEY (institution_id, series_id) REFERENCES series (institution_id, id);
CREATE INDEX facts_series_time ON evidence_facts (institution_id, series_id, valid_time);
CREATE INDEX facts_subject ON evidence_facts (institution_id, subject, predicate, valid_time);
