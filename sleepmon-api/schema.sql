-- SleepMon v3 (SpO2 + RMS only) 7-day retention (cleanup by cron)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,           -- epoch seconds (UTC)
  spo2 REAL,                     -- percent
  rms  REAL,                     -- audio RMS (0..1)
  alarmA INTEGER DEFAULT 0        -- 0/1
);

CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry(ts);

CREATE TABLE IF NOT EXISTS abnormal_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,           -- epoch seconds (UTC)
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abnormal_ts ON abnormal_files(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_abnormal_key ON abnormal_files(r2_key);
