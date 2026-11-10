-- Identity: principals can be disabled (never deleted); roles are managed through the API and every change is audited.
ALTER TABLE principals ADD COLUMN disabled_at timestamptz;
GRANT INSERT, UPDATE ON principals TO tigeris_app;
GRANT INSERT, DELETE ON principal_roles TO tigeris_app;
