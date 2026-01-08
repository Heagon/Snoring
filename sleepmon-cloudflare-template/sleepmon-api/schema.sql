PRAGMA foreign_keys = ON;

-- ===============================
-- SleepMon v2 schema (Telemetry + Abnormal audio)
-- ===============================

-- 1) Time-series telemetry (only what web needs: SpO2 + RMS)
--    Still stores a few flags for debugging.
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- epoch seconds (UTC)
  spo2 REAL,
  rms REAL,                            -- RMS used by dashboard (use rmsFast from device)
  rms1s REAL,
  finger INTEGER,
  ppg_ok INTEGER,
  alarmA INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry(ts);

-- 2) Uploaded abnormal wav files
CREATE TABLE IF NOT EXISTS audio_files (
  r2_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- epoch seconds (UTC)
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  kind TEXT NOT NULL DEFAULT 'abnormal',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audio_device_ts ON audio_files(device_id, ts);
CREATE INDEX IF NOT EXISTS idx_audio_ts ON audio_files(ts);
