ALTER TABLE device_pairings ADD COLUMN last_button_event_id TEXT;
ALTER TABLE device_pairings ADD COLUMN last_button_event_at_ms INTEGER;
ALTER TABLE device_pairings ADD COLUMN last_button_event_boot_id TEXT;
ALTER TABLE device_pairings ADD COLUMN last_button_event_press_id INTEGER;
ALTER TABLE device_pairings ADD COLUMN last_button_event_json TEXT;
ALTER TABLE device_pairings ADD COLUMN last_button_event_claimed_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS device_pairings_button_event_freshness
  ON device_pairings(last_button_event_at_ms, last_button_event_claimed_at_ms);
