CREATE TABLE IF NOT EXISTS segmentation_host_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint_url TEXT NOT NULL DEFAULT '',
  encrypted_service_token TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO segmentation_host_config(id, endpoint_url, encrypted_service_token, updated_at)
VALUES (1, '', '', datetime('now'));
