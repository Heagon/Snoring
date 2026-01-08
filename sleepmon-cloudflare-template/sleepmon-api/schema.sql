PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity INTEGER DEFAULT 0,
  ts_start INTEGER NOT NULL,
  ts_end INTEGER,
  spo2_min INTEGER,
  spo2_avg REAL,
  hr_avg REAL,
  audio_upload_id TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device_id, ts_start DESC);

CREATE TABLE IF NOT EXISTS nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_device_created ON uploads(device_id, created_at DESC);
