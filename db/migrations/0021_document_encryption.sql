-- Document contents can be sealed by the application with a key the database never holds. The page text then lives in text_enc, and search runs over keyed word tokens instead of the text.
ALTER TABLE document_pages ADD COLUMN text_enc bytea;
ALTER TABLE document_pages ADD CONSTRAINT document_pages_sealed CHECK (text_enc IS NULL OR text = '');

CREATE TABLE document_terms (
  institution_id uuid NOT NULL, document_id uuid NOT NULL, page_no int NOT NULL,
  term bytea NOT NULL CHECK (length(term) = 16),
  freq int NOT NULL CHECK (freq > 0),
  PRIMARY KEY (document_id, page_no, term),
  FOREIGN KEY (institution_id, document_id) REFERENCES documents (institution_id, id)
);
CREATE INDEX document_terms_lookup ON document_terms (institution_id, term);
ALTER TABLE document_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_terms USING (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = NULLIF(current_setting('app.institution_id', true), '')::uuid);
CREATE TRIGGER document_terms_immutable BEFORE UPDATE OR DELETE ON document_terms FOR EACH ROW EXECUTE FUNCTION forbid_change();
GRANT SELECT, INSERT ON document_terms TO tigeris_app;
