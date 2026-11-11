-- Lists are read newest first in pages. These indexes let each page start where the last one ended without sorting the whole table.
CREATE INDEX cases_updated ON cases (institution_id, updated_at DESC, id DESC);
CREATE INDEX documents_created ON documents (institution_id, created_at DESC, id DESC);
CREATE INDEX handoffs_created ON action_handoffs (institution_id, created_at DESC, id DESC);
CREATE INDEX runs_created ON scenario_runs (institution_id, created_at DESC, id DESC);
CREATE INDEX memory_created ON memory_records (institution_id, created_at DESC, id DESC);
CREATE INDEX evidence_retrieved ON evidence_objects (institution_id, retrieved_at DESC, id DESC);
CREATE INDEX reasoning_calls_page ON reasoning_calls (institution_id, created_at DESC, id DESC);
