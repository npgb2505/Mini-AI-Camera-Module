CREATE TABLE IF NOT EXISTS device_pair_claims (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS device_pair_claims_expiry
  ON device_pair_claims(expires_at_ms);

ALTER TABLE device_pairings ADD COLUMN last_event_id TEXT;
ALTER TABLE device_pairings ADD COLUMN last_event_at_ms INTEGER;
ALTER TABLE device_pairings ADD COLUMN last_event_boot_id TEXT;
ALTER TABLE device_pairings ADD COLUMN last_event_seq INTEGER;
ALTER TABLE device_pairings ADD COLUMN last_event_json TEXT;
