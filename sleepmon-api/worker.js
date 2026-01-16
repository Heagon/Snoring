/**
 * SleepMon Cloudflare Worker API (D1)
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /telemetry             (auth) JSON { ts, spo2, rms, alarmA }
 *  - GET  /telemetry/latest      (public by default)
 *  - GET  /telemetry/days?dates=YYYY-MM-DD,YYYY-MM-DD
 *
 *  - POST /abnormal/mark         (auth) JSON { ts, filename }
 *  - GET  /abnormal/list?days=7  (public by default)
 *
 * Bindings (wrangler.toml):
 *  - DB: D1 database
 *  - AUTH_TOKEN: env var (string)
 *
 * Notes:
 *  - GET routes can be public, while POST routes require Bearer token.
 *  - You can flip READ_PUBLIC to false to require auth on reads.
 */
const READ_PUBLIC = true;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function requireAuth(req, env) {
  const h = req.headers.get("Authorization") || "";
  const want = "Bearer " + (env.AUTH_TOKEN || "");
  if (!env.AUTH_TOKEN) return false;
  return h === want;
}

function mustAuth(req, env) {
  if (!requireAuth(req, env)) {
    throw new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }
}

function getTzDayFromEpochSec(ts) {
  // derive YYYY-MM-DD in Hanoi (+07:00) from epoch seconds
  const d = new Date(ts * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const get = (t) => fmt.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayStartEndSec(isoDay) {
  // isoDay: YYYY-MM-DD (Hanoi)
  const startMs = Date.parse(`${isoDay}T00:00:00+07:00`);
  if (!Number.isFinite(startMs)) return null;
  return { start: Math.floor(startMs / 1000), end: Math.floor(startMs / 1000) + 86400 };
}

async function ensureSchema(db) {
  const schema = [
    `CREATE TABLE IF NOT EXISTS telemetry (
      ts INTEGER NOT NULL PRIMARY KEY,
      spo2 REAL,
      rms REAL,
      alarmA INTEGER
    );`,
    `CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts);`,

    `CREATE TABLE IF NOT EXISTS abnormal_marks (
      key TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      filename TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS abnormal_ts ON abnormal_marks(ts);`,
    `CREATE INDEX IF NOT EXISTS abnormal_day ON abnormal_marks(day);`,
  ];

  for (const stmt of schema) {
    await db.exec(stmt);
  }
}

function safeFilename(name) {
  const s = String(name || "");
  // Keep it readable and stable; do not allow path traversal.
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 120) || "unknown";
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS_HEADERS });

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (!env.DB) return bad("Missing D1 binding DB", 500);
      await ensureSchema(env.DB);

      // Health
      if (req.method === "GET" && path === "/health") {
        return json({ ok: true, now: Math.floor(Date.now() / 1000) });
      }

      // Telemetry POST
      if (req.method === "POST" && path === "/telemetry") {
        mustAuth(req, env);

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return bad("Invalid JSON");

        const ts = Number(body.ts || Math.floor(Date.now() / 1000));
        const spo2 = body.spo2 === null || body.spo2 === undefined ? null : Number(body.spo2);
        const rms = body.rms === null || body.rms === undefined ? null : Number(body.rms);
        const alarmA = body.alarmA === null || body.alarmA === undefined ? null : Number(body.alarmA);

        if (!Number.isFinite(ts) || ts <= 0) return bad("Bad ts");

        await env.DB.prepare(
          "INSERT OR REPLACE INTO telemetry (ts, spo2, rms, alarmA) VALUES (?, ?, ?, ?)"
        )
          .bind(ts, spo2, rms, alarmA)
          .run();

        return json({ ok: true });
      }

      // Telemetry latest
      if (req.method === "GET" && path === "/telemetry/latest") {
        if (!READ_PUBLIC) mustAuth(req, env);

        const row = await env.DB.prepare(
          "SELECT ts, spo2, rms, alarmA FROM telemetry ORDER BY ts DESC LIMIT 1"
        ).first();

        return json({ ok: true, point: row || null });
      }

      // Telemetry days
      if (req.method === "GET" && path === "/telemetry/days") {
        if (!READ_PUBLIC) mustAuth(req, env);

        const datesParam = url.searchParams.get("dates") || "";
        const dates = datesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        if (!dates.length) return json({ ok: true, days: {} });

        const out = {};
        for (const d of dates) {
          const rng = dayStartEndSec(d);
          if (!rng) {
            out[d] = [];
            continue;
          }

          const rows = await env.DB.prepare(
            "SELECT ts, spo2, rms, alarmA FROM telemetry WHERE ts >= ? AND ts < ? ORDER BY ts ASC"
          )
            .bind(rng.start, rng.end)
            .all();

          out[d] = rows.results || [];
        }

        return json({ ok: true, days: out });
      }

      // Mark abnormal (store metadata only)
      if (req.method === "POST" && path === "/abnormal/mark") {
        mustAuth(req, env);

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return bad("Invalid JSON");

        const ts = Number(body.ts || 0);
        const filename = safeFilename(body.filename || "");
        if (!Number.isFinite(ts) || ts <= 0) return bad("Bad ts");
        if (!filename) return bad("Bad filename");

        const day = getTzDayFromEpochSec(ts);
        const key = `abn/${day}/${ts}_${filename}`;

        await env.DB.prepare(
          "INSERT OR REPLACE INTO abnormal_marks (key, ts, day, filename) VALUES (?, ?, ?, ?)"
        )
          .bind(key, ts, day, filename)
          .run();

        return json({ ok: true, key, ts, day, filename });
      }

      // List abnormal marks
      if (req.method === "GET" && path === "/abnormal/list") {
        if (!READ_PUBLIC) mustAuth(req, env);

        const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") || 7)));
        const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

        const rows = await env.DB.prepare(
          "SELECT key, ts, day, filename FROM abnormal_marks WHERE ts >= ? ORDER BY ts DESC"
        )
          .bind(cutoff)
          .all();

        return json({ ok: true, items: rows.results || [] });
      }

      // Deprecated routes (kept to avoid confusion with older firmware/UI)
      if (req.method === "POST" && path === "/upload_wav") {
        return bad("Audio upload disabled. Use POST /abnormal/mark (filename only).", 410);
      }
      if (req.method === "GET" && path === "/abnormal/get") {
        return bad("Abnormal audio fetch disabled. Use GET /abnormal/list for markers.", 410);
      }

      return bad("Not found", 404);
    } catch (e) {
      if (e instanceof Response) return e;
      return bad(String(e && e.message ? e.message : e), 500);
    }
  },
};
