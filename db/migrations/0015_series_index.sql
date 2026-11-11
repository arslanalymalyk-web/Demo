-- The series list finds the newest evidence record behind each series. This index lets it read the distinct evidence ids of a series without scanning every fact.
CREATE INDEX facts_series_evidence ON evidence_facts (institution_id, series_id, evidence_id);
