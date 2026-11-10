-- Document intake: the original file is kept unchanged, extraction is recorded page by page, and the result becomes ordinary evidence.
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  data_class data_class NOT NULL,
  original_agency text,
  source_url text,
  rights_statement text NOT NULL,
  languages text NOT NULL DEFAULT 'eng',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'quarantined')),
  error text,
  page_count int,
  language text,
  ocr_used boolean,
  avg_confidence real,
  evidence_id uuid,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (institution_id, sha256),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, evidence_id) REFERENCES evidence_objects (institution_id, id),
  FOREIGN KEY (institution_id, uploaded_by) REFERENCES principals (institution_id, id)
);

CREATE TABLE document_files (
  institution_id uuid NOT NULL, document_id uuid PRIMARY KEY, content bytea NOT NULL,
  FOREIGN KEY (institution_id, document_id) REFERENCES documents (institution_id, id)
);

CREATE TABLE document_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL, document_id uuid NOT NULL, page_no int NOT NULL CHECK (page_no > 0),
  method text NOT NULL CHECK (method IN ('text-layer', 'ocr', 'plain', 'docx')),
  text text NOT NULL, char_count int NOT NULL, confidence real, text_sha256 char(64) NOT NULL,
  UNIQUE (document_id, page_no),
  FOREIGN KEY (institution_id, document_id) REFERENCES documents (institution_id, id)
);
CREATE INDEX document_pages_search ON document_pages USING gin (to_tsvector('simple', text));

CREATE TRIGGER document_files_immutable BEFORE UPDATE OR DELETE ON document_files FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER document_pages_immutable BEFORE UPDATE OR DELETE ON document_pages FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Only processing state may change on a document. The file identity and its declared origin never do.
CREATE FUNCTION documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on documents is not allowed' USING ERRCODE = '55000'; END IF;
  IF (NEW.title, NEW.filename, NEW.mime, NEW.size_bytes, NEW.sha256, NEW.data_class, NEW.original_agency, NEW.source_url, NEW.rights_statement, NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM (OLD.title, OLD.filename, OLD.mime, OLD.size_bytes, OLD.sha256, OLD.data_class, OLD.original_agency, OLD.source_url, OLD.rights_statement, OLD.uploaded_by, OLD.created_at)
  THEN RAISE EXCEPTION 'a document and its declared origin are immutable; only processing state may change' USING ERRCODE = '55000'; END IF;
  IF OLD.status IN ('ready', 'quarantined') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'a processed document does not change state' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_guard_t BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION documents_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'document_files', 'document_pages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON documents TO tigeris_app;
GRANT SELECT, INSERT ON document_files, document_pages TO tigeris_app;
