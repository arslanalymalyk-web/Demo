-- A person's sessions can be ended at any moment: a token issued before this time is refused, however long its own expiry says it lasts.
ALTER TABLE principals ADD COLUMN sessions_valid_after timestamptz;
