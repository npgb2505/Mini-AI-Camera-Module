CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_host_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'cloudflare' CHECK (provider IN ('cloudflare', 'yolo_host')),
  model_name TEXT NOT NULL DEFAULT 'moondream-cloud',
  endpoint_url TEXT NOT NULL DEFAULT '',
  encrypted_api_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO model_host_config(id, provider, model_name, endpoint_url, encrypted_api_key, updated_at)
VALUES (1, 'cloudflare', 'moondream-cloud', '', '', datetime('now'));

INSERT OR IGNORE INTO app_settings(key, value)
SELECT 'model_settings_admin_id', id FROM users ORDER BY created_at, id LIMIT 1;
