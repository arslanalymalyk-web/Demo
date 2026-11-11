-- Access that ends by itself: support staff, auditors and vendor engineers get an expiry, and the application refuses them after it.
ALTER TABLE principals ADD COLUMN expires_at timestamptz;
