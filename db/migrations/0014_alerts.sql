-- Alerts: a short notice by email when something needs a person. The notice carries a category, a reference and a link, never record content.
ALTER TABLE principals ADD COLUMN email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@[:space:]<>",;]+@[^@[:space:]<>",;]+\.[^@[:space:]<>",;]+$'));

-- One row per condition that has raised or is raising a notice. Operational state: it changes as conditions open, repeat and clear.
CREATE TABLE alert_conditions (
  institution_id uuid NOT NULL,
  condition_key text NOT NULL CHECK (length(condition_key) BETWEEN 3 AND 200),
  category text NOT NULL CHECK (category IN ('malware', 'source', 'review', 'operations')),
  kind text NOT NULL CHECK (kind IN ('event', 'state')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  ref text,
  link text,
  detail text,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notify_count int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  resolved_at timestamptz,
  PRIMARY KEY (institution_id, condition_key),
  FOREIGN KEY (institution_id) REFERENCES institutions (id)
);
CREATE INDEX alert_conditions_open ON alert_conditions (institution_id, state, category);

-- Every message attempted, to whom (by person, never by address) and with what result. Append only.
CREATE TABLE alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  condition_key text NOT NULL,
  category text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('raised', 'reminder', 'resolved', 'test')),
  principal_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  reason text,
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id)
);
CREATE INDEX alert_deliveries_time ON alert_deliveries (institution_id, created_at DESC);
CREATE TRIGGER alert_deliveries_immutable BEFORE UPDATE OR DELETE ON alert_deliveries FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A person may switch off the categories that are not security-relevant. Malware and operations notices cannot be switched off.
CREATE TABLE alert_preferences (
  institution_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('source', 'review')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, principal_id, category),
  FOREIGN KEY (institution_id, principal_id) REFERENCES principals (institution_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_conditions', 'alert_deliveries', 'alert_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON alert_conditions, alert_preferences TO tigeris_app;
GRANT SELECT, INSERT ON alert_deliveries TO tigeris_app;
