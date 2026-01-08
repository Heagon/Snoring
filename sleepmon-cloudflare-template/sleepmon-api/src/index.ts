export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  // Optional: if set, device must send header X-Device-Token to POST endpoints.
  DEVICE_TOKEN?: string;
}

// ---- helpers ----

const TZ = "Asia/Ho_Chi_Minh";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...init.headers,
    },
    ...init,
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, x-filename, x-timestamp, x-device-id, x-device-token",
  };
}

function badRequest(message: string, status = 400) {
  return json({ ok: false, error: message }, { status });
}

function requireDeviceToken(env: Env, req: Request) {
  if (!env.DEVICE_TOKEN) return { ok: true };
  const got = req.headers.get("x-device-token") || "";
  if (got && got === env.DEVICE_TOKEN) return { ok: true };
  return { ok: false, resp: badRequest("unauthorized", 401) } as const;
}

function getDeviceId(req: Request) {
  return (req.headers.get("x-device-id") || "esp32").slice(0, 64);
}

function fmtDate(tsSec: number) {
  const d = new Date(tsSec * 1000);
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function fmtTime(tsSec: number) {
  const d = new Date(tsSec * 1000);
  // 24h time
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

function localDayToUtcRange(dateYYYYMMDD: string) {
  // Interpret date as local midnight in GMT+7, convert to epoch seconds UTC.
  // YYYY-MM-DDT00:00:00+07:00
  const startMs = Date.parse(`${dateYYYYMMDD}T00:00:00+07:00`);
  if (!Number.isFinite(startMs)) return null;
  const startSec = Math.floor(startMs / 1000);
  return { startSec, endSec: startSec + 86400 };
}

function parseDays(v: string | null, def = 7) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const x = Math.floor(n);
  if (x < 1) return 1;
  if (x > 7) return 7;
  return x;
}

// ---- routes ----

async function handleTelemetryPost(env: Env, req: Request) {
  const auth = requireDeviceToken(env, req);
  if (!auth.ok) return auth.resp;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  const deviceId = getDeviceId(req);
  const ts = Number(body?.ts);
  const spo2 = Number(body?.spo2);

  // Prefer fast RMS; fallback to rms1s.
  const rms = Number.isFinite(Number(body?.rmsFast)) ? Number(body?.rmsFast) : Number(body?.rms1s);

  if (!Number.isFinite(ts) || ts <= 0) return badRequest("missing/invalid ts");
  if (!Number.isFinite(spo2)) return badRequest("missing/invalid spo2");
  if (!Number.isFinite(rms)) return badRequest("missing/invalid rms");

  const finger = Number.isFinite(Number(body?.finger)) ? Number(body.finger) : null;
  const ppg_ok = Number.isFinite(Number(body?.ppg_ok)) ? Number(body.ppg_ok) : null;
  const alarmA = Number.isFinite(Number(body?.alarmA)) ? Number(body.alarmA) : null;

  const note = {
    pi: body?.pi ?? null,
    env: body?.env ?? null,
    envMode: body?.envMode ?? null,
    nf: body?.nf ?? null,
    snore_abn: body?.snore_abn ?? null,
  };

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO telemetry (device_id, ts, spo2, rms, finger, ppg_ok, alarmA, note_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(deviceId, ts, spo2, rms, finger, ppg_ok, alarmA, JSON.stringify(note), now)
    .run();

  return json({ ok: true });
}

async function handleTelemetryGet(env: Env, url: URL, req: Request) {
  const date = url.searchParams.get("date");
  const deviceId = (url.searchParams.get("device") || "esp32").slice(0, 64);

  if (!date) return badRequest("missing date=YYYY-MM-DD");
  const range = localDayToUtcRange(date);
  if (!range) return badRequest("invalid date");

  const rows = await env.DB.prepare(
    `SELECT ts, spo2, rms FROM telemetry
     WHERE device_id=?1 AND ts>=?2 AND ts<?3
     ORDER BY ts ASC`
  )
    .bind(deviceId, range.startSec, range.endSec)
    .all();

  return json({ ok: true, tz: TZ, date, device_id: deviceId, points: rows.results ?? [] });
}

async function handleTelemetryLatest(env: Env, url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 120), 1), 2000);
  const deviceId = (url.searchParams.get("device") || "esp32").slice(0, 64);

  const rows = await env.DB.prepare(
    `SELECT ts, spo2, rms FROM telemetry
     WHERE device_id=?1
     ORDER BY ts DESC
     LIMIT ?2`
  )
    .bind(deviceId, limit)
    .all();

  const pts = (rows.results ?? []).reverse();
  return json({ ok: true, tz: TZ, device_id: deviceId, points: pts });
}

async function handleUploadWav(env: Env, req: Request) {
  const auth = requireDeviceToken(env, req);
  if (!auth.ok) return auth.resp;

  const deviceId = getDeviceId(req);
  const filename = (req.headers.get("x-filename") || "abnormal.wav").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const ts = Number(req.headers.get("x-timestamp") || "0");

  if (!Number.isFinite(ts) || ts <= 0) return badRequest("missing/invalid X-Timestamp");

  const buf = await req.arrayBuffer();
  const size = buf.byteLength;
  if (size < 44) return badRequest("file too small");

  const date = fmtDate(ts);
  const key = `abnormal/${date}/${ts}_${filename}`;

  await env.AUDIO.put(key, buf, {
    httpMetadata: {
      contentType: "audio/wav",
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      device_id: deviceId,
      date,
      time: fmtTime(ts),
    },
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO abnormal_audio (r2_key, device_id, ts, date_local, time_local, filename, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(key, deviceId, ts, date, fmtTime(ts), filename, size, now)
    .run();

  return json({ ok: true, key, size_bytes: size });
}

async function handleAbnormalList(env: Env, url: URL) {
  const days = parseDays(url.searchParams.get("days"), 7);
  const deviceId = (url.searchParams.get("device") || "esp32").slice(0, 64);

  const nowSec = Math.floor(Date.now() / 1000);
  // last N days by ts (UTC epoch)
  const since = nowSec - days * 86400;

  const rows = await env.DB.prepare(
    `SELECT r2_key, ts, date_local, time_local, filename, size_bytes
     FROM abnormal_audio
     WHERE device_id=?1 AND ts>=?2
     ORDER BY ts DESC
     LIMIT 500`
  )
    .bind(deviceId, since)
    .all();

  // Provide a stable download URL served by this Worker.
  const origin = new URL(url.toString());
  origin.pathname = "";
  origin.search = "";

  const items = (rows.results ?? []).map((r: any) => ({
    ...r,
    url: `${origin.toString().replace(/\/$/, "")}/audio/${encodeURIComponent(r.r2_key)}`,
  }));

  return json({ ok: true, tz: TZ, device_id: deviceId, days, items });
}

async function handleAudioGet(env: Env, key: string) {
  const obj = await env.AUDIO.get(key);
  if (!obj) return badRequest("not found", 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("access-control-allow-origin", "*");

  return new Response(obj.body, { headers });
}

// ---- worker entry ----

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health
    if (req.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "sleepmon-api",
        tz: TZ,
        endpoints: {
          telemetry_post: "POST /telemetry",
          telemetry_by_date: "GET /telemetry?date=YYYY-MM-DD",
          telemetry_latest: "GET /telemetry/latest?limit=120",
          upload_wav: "POST /upload_wav (audio/wav, headers X-Filename, X-Timestamp)",
          abnormal_list: "GET /abnormal?days=1..7",
          audio_get: "GET /audio/<r2_key>",
        },
      });
    }

    // Telemetry
    if (url.pathname === "/telemetry") {
      if (req.method === "POST") return handleTelemetryPost(env, req);
      if (req.method === "GET") return handleTelemetryGet(env, url, req);
      return badRequest("method not allowed", 405);
    }

    if (url.pathname === "/telemetry/latest" && req.method === "GET") {
      return handleTelemetryLatest(env, url);
    }

    // WAV upload
    if (url.pathname === "/upload_wav" && req.method === "POST") {
      return handleUploadWav(env, req);
    }

    // Abnormal listing
    if (url.pathname === "/abnormal" && req.method === "GET") {
      return handleAbnormalList(env, url);
    }

    // Audio download/proxy
    if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
      const key = decodeURIComponent(url.pathname.slice("/audio/".length));
      return handleAudioGet(env, key);
    }

    return badRequest("not found", 404);
  },
};
