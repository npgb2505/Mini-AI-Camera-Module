CREATE TABLE IF NOT EXISTS device_pairings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  paired_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  last_device_id TEXT,
  last_boot_id TEXT,
  last_seq INTEGER,
  last_telemetry_json TEXT
);

CREATE INDEX IF NOT EXISTS device_pairings_last_seen
  ON device_pairings(last_seen_at_ms);
