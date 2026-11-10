-- Reasoning: a record of every call to a language model. The model drafts; code verifies; a person decides.
-- The row holds what was asked (as hashes), which model answered, the raw answer, the verdict and, only when verified, the output.
CREATE TABLE reasoning_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  task text NOT NULL CHECK (task IN ('summary_briefing', 'summary_case', 'questions_case', 'answer', 'recommendation_case')),
  subject text,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_hash char(64) NOT NULL,
  facts_hash char(64) NOT NULL,
  fact_count int NOT NULL CHECK (fact_count >= 0),
  data_classes text[] NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('accepted', 'rejected', 'refused', 'blocked', 'error')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_output text,
  output jsonb,
  input_tokens int,
  output_tokens int,
  duration_ms int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id),
  CHECK ((verdict = 'accepted') = (output IS NOT NULL))
);
CREATE INDEX reasoning_calls_time ON reasoning_calls (institution_id, created_at DESC);
CREATE TRIGGER reasoning_calls_immutable BEFORE UPDATE OR DELETE ON reasoning_calls FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE reasoning_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE reasoning_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reasoning_calls USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
GRANT SELECT, INSERT ON reasoning_calls TO tigeris_app;
