-- Cases, recommendations, policy decisions, human decisions, handoffs and institutional memory.
-- Everything that records what was decided, by whom, under which policy version, is append-only.

CREATE TYPE case_state AS ENUM ('open', 'analysis', 'in_review', 'decided', 'closed');
CREATE TYPE case_sensitivity AS ENUM ('internal', 'restricted');
CREATE TYPE action_class AS ENUM ('monitor', 'advisory', 'handoff');
CREATE TYPE policy_outcome AS ENUM ('PASS', 'HOLD', 'BLOCK');
CREATE TYPE decision_kind AS ENUM ('approve', 'reject', 'defer', 'request_evidence');
CREATE TYPE handoff_status AS ENUM ('open', 'done', 'cancelled');

CREATE TABLE case_counters (institution_id uuid PRIMARY KEY REFERENCES institutions(id), n int NOT NULL DEFAULT 0);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  case_key text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  objective text NOT NULL CHECK (length(objective) >= 3),
  domain text NOT NULL,
  sensitivity case_sensitivity NOT NULL DEFAULT 'internal',
  state case_state NOT NULL DEFAULT 'open',
  owner_id uuid NOT NULL,
  reviewer_id uuid,
  disposition text,
  version int NOT NULL DEFAULT 1,
  start_snapshot jsonb NOT NULL,
  signal jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (institution_id, case_key),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, owner_id) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, reviewer_id) REFERENCES principals (institution_id, id)
);

CREATE TABLE case_participants (
  institution_id uuid NOT NULL, case_id uuid NOT NULL, principal_id uuid NOT NULL, role text NOT NULL CHECK (role IN ('owner', 'reviewer', 'contributor')),
  PRIMARY KEY (case_id, principal_id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id)
);

CREATE TABLE case_events (
  id bigserial PRIMARY KEY, institution_id uuid NOT NULL, case_id uuid NOT NULL, seq int NOT NULL, actor_id uuid NOT NULL,
  kind text NOT NULL, rationale text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq), FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id)
);

CREATE TABLE case_evidence (
  institution_id uuid NOT NULL, case_id uuid NOT NULL, evidence_id uuid NOT NULL, role text NOT NULL CHECK (role IN ('supports', 'contradicts', 'context')),
  note text, added_by uuid NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, evidence_id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id)
);

CREATE TABLE case_scenarios (
  institution_id uuid NOT NULL, case_id uuid NOT NULL, run_id uuid NOT NULL, added_by uuid NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, run_id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, run_id) REFERENCES scenario_runs (institution_id, id)
);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL, case_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200), description text NOT NULL, constraints_text text,
  action_class action_class NOT NULL, scenario_run_id uuid, owner_id uuid, author_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'decided', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, scenario_run_id) REFERENCES scenario_runs (institution_id, id),
  FOREIGN KEY (institution_id, owner_id) REFERENCES principals (institution_id, id),
  FOREIGN KEY (institution_id, author_id) REFERENCES principals (institution_id, id)
);

CREATE TABLE recommendation_evidence (
  institution_id uuid NOT NULL, recommendation_id uuid NOT NULL, evidence_id uuid NOT NULL,
  PRIMARY KEY (recommendation_id, evidence_id),
  FOREIGN KEY (institution_id, recommendation_id) REFERENCES recommendations (institution_id, id),
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL REFERENCES institutions(id),
  key text NOT NULL, version int NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  rules jsonb NOT NULL, authority jsonb NOT NULL, created_by text NOT NULL, activated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
  UNIQUE (institution_id, key, version), UNIQUE (institution_id, id)
);
CREATE UNIQUE INDEX one_active_policy ON policies (institution_id, key) WHERE status = 'active';

CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL, case_id uuid NOT NULL, recommendation_id uuid NOT NULL, policy_id uuid NOT NULL,
  outcome policy_outcome NOT NULL, results jsonb NOT NULL, manifest jsonb NOT NULL, manifest_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, recommendation_id) REFERENCES recommendations (institution_id, id),
  FOREIGN KEY (institution_id, policy_id) REFERENCES policies (institution_id, id)
);

CREATE TABLE human_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL, case_id uuid NOT NULL, recommendation_id uuid NOT NULL, policy_decision_id uuid NOT NULL,
  decision decision_kind NOT NULL, rationale text NOT NULL CHECK (length(rationale) >= 10), actor_id uuid NOT NULL, case_version int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, recommendation_id) REFERENCES recommendations (institution_id, id),
  FOREIGN KEY (institution_id, policy_decision_id) REFERENCES policy_decisions (institution_id, id),
  FOREIGN KEY (institution_id, actor_id) REFERENCES principals (institution_id, id)
);

CREATE TABLE action_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL, case_id uuid NOT NULL, decision_id uuid NOT NULL,
  task text NOT NULL, owner_id uuid, status handoff_status NOT NULL DEFAULT 'open', outcome text, updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, decision_id) REFERENCES human_decisions (institution_id, id),
  FOREIGN KEY (institution_id, owner_id) REFERENCES principals (institution_id, id)
);

CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), institution_id uuid NOT NULL, case_id uuid NOT NULL, decision_id uuid NOT NULL,
  title text NOT NULL, summary text NOT NULL, domain text NOT NULL, sensitivity case_sensitivity NOT NULL, decision decision_kind NOT NULL, outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id),
  FOREIGN KEY (institution_id, case_id) REFERENCES cases (institution_id, id),
  FOREIGN KEY (institution_id, decision_id) REFERENCES human_decisions (institution_id, id)
);
CREATE INDEX memory_search ON memory_records USING gin (to_tsvector('simple', title || ' ' || summary || ' ' || COALESCE(outcome, '')));

-- Append-only tables.
CREATE TRIGGER case_events_immutable BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_evidence_immutable BEFORE UPDATE OR DELETE ON case_evidence FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_scenarios_immutable BEFORE UPDATE OR DELETE ON case_scenarios FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER recommendation_evidence_immutable BEFORE UPDATE OR DELETE ON recommendation_evidence FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER policy_decisions_immutable BEFORE UPDATE OR DELETE ON policy_decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER human_decisions_immutable BEFORE UPDATE OR DELETE ON human_decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER memory_records_immutable BEFORE UPDATE OR DELETE ON memory_records FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Partly mutable tables: only the named columns may change, and never be deleted.
CREATE FUNCTION recommendations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on recommendations is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.title, NEW.description, NEW.constraints_text, NEW.action_class, NEW.scenario_run_id, NEW.owner_id, NEW.author_id, NEW.case_id) IS DISTINCT FROM
     (OLD.title, OLD.description, OLD.constraints_text, OLD.action_class, OLD.scenario_run_id, OLD.owner_id, OLD.author_id, OLD.case_id)
  THEN RAISE EXCEPTION 'recommendation content is immutable; only status may change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recommendations_guard_t BEFORE UPDATE OR DELETE ON recommendations FOR EACH ROW EXECUTE FUNCTION recommendations_guard();

CREATE FUNCTION policies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on policies is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.key, NEW.version, NEW.rules, NEW.authority, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.key, OLD.version, OLD.rules, OLD.authority, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'a policy version is immutable; create a new version' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_guard_t BEFORE UPDATE OR DELETE ON policies FOR EACH ROW EXECUTE FUNCTION policies_guard();

CREATE FUNCTION handoffs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on action_handoffs is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.case_id, NEW.decision_id, NEW.task, NEW.created_at) IS DISTINCT FROM (OLD.case_id, OLD.decision_id, OLD.task, OLD.created_at)
  THEN RAISE EXCEPTION 'handoff task is immutable; only status and outcome may change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER handoffs_guard_t BEFORE UPDATE OR DELETE ON action_handoffs FOR EACH ROW EXECUTE FUNCTION handoffs_guard();

CREATE FUNCTION cases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on cases is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.case_key, NEW.owner_id, NEW.start_snapshot, NEW.created_at, NEW.sensitivity, NEW.domain) IS DISTINCT FROM (OLD.case_key, OLD.owner_id, OLD.start_snapshot, OLD.created_at, OLD.sensitivity, OLD.domain)
  THEN RAISE EXCEPTION 'case identity and starting snapshot are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD.state = 'closed' THEN RAISE EXCEPTION 'a closed case cannot change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_guard_t BEFORE UPDATE OR DELETE ON cases FOR EACH ROW EXECUTE FUNCTION cases_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['case_counters','cases','case_participants','case_events','case_evidence','case_scenarios','recommendations','recommendation_evidence','policies','policy_decisions','human_decisions','action_handoffs','memory_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON case_counters, cases, recommendations, policies, action_handoffs TO tigeris_app;
GRANT SELECT, INSERT ON case_participants, case_events, case_evidence, case_scenarios, recommendation_evidence, policy_decisions, human_decisions, memory_records TO tigeris_app;
GRANT USAGE ON SEQUENCE case_events_id_seq TO tigeris_app;
