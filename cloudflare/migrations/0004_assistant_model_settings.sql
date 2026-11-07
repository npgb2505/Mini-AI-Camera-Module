CREATE TABLE IF NOT EXISTS assistant_model_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'cloudflare' CHECK (provider IN ('cloudflare', 'openai')),
  model_name TEXT NOT NULL DEFAULT '@cf/qwen/qwen3.8-27b',
  encrypted_api_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO assistant_model_config(id, provider, model_name, encrypted_api_key, updated_at)
VALUES (1, 'cloudflare', '@cf/qwen/qwen3.8-27b', '', datetime('now'));
