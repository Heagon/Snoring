export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  AUTH_TOKEN?: string; // set via `wrangler secret put AUTH_TOKEN`
}

const TZ_OFFSET_SECONDS = 7 * 3600; // Hanoi is UTC+7 (no DST)
const RETENTION_SECONDS = 7 * 24 * 3600;

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Filename, X-Timestamp");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function isAuthorized(req: Request, env: Env): boolean {
  const token = env.AUTH_TOKEN;
  if (!token) return false;
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === token;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "abnormal.wav";
}

function pad2(n: number) { return n < 10 ? "0" + n : "" + n; }

function hanoiDayToUtcRange(dateStr: string): { start: number; end: number } | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;

  const startMsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0) - (TZ_OFFSET_SECONDS * 1000);
  const endMsUtc = startMsUtc + 24 * 3600 * 1000;
  return { start: Math.floor(startMsUtc / 1000), end: Math.floor(endMsUtc / 1000) };
}

function epochToHanoiDate(tsSec: number): string {
  const ms = (tsSec + TZ_OFFSET_SECONDS) * 1000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

async function cleanupOld(env: Env, nowSec: number) {
  const cutoff = nowSec - RETENTION_SECONDS;

  await env.DB.prepare("DELETE FROM telemetry WHERE ts < ?").bind(cutoff).run();

  const old = await env.DB.prepare(
    "SELECT r2_key FROM abnormal_files WHERE ts < ? ORDER BY ts ASC LIMIT 200"
  ).bind(cutoff).all<{ r2_key: string }>();

  for (const row of old.results ?? []) {
    try { await env.AUDIO.delete(row.r2_key); } catch (_) {}
    await env.DB.prepare("DELETE FROM abnormal_files WHERE r2_key = ?").bind(row.r2_key).run();
  }
}

async function handleTelemetryPost(req: Request, env: Env) {
  if (!isAuthorized(req, env)) return json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "invalid_json" }, { status: 400 }); }

  const nowSec = Math.floor(Date.now() / 1000);
  const ts = Number(body.ts ?? nowSec);
  const spo2 = body.spo2 === undefined ? null : Number(body.spo2);
  const rms  = body.rmsFast !== undefined ? Number(body.rmsFast) :
               body.rms !== undefined ? Number(body.rms) :
               body.rms1s !== undefined ? Number(body.rms1s) : null;
  const alarmA = Number(body.alarmA ?? 0);

  if (!Number.isFinite(ts) || ts <= 0) return json({ ok:false, error:"bad_ts" }, {status:400});
  if (spo2 !== null && !Number.isFinite(spo2)) return json({ ok:false, error:"bad_spo2" }, {status:400});
  if (rms  !== null && !Number.isFinite(rms))  return json({ ok:false, error:"bad_rms" }, {status:400});

  await env.DB.prepare(
    "INSERT INTO telemetry (ts, spo2, rms, alarmA) VALUES (?, ?, ?, ?)"
  ).bind(ts, spo2, rms, alarmA).run();

  if (Math.abs(ts - nowSec) < 10) {
    await cleanupOld(env, nowSec);
  }

  return json({ ok: true });
}

async function handleTelemetryLatest(env: Env) {
  const q = await env.DB.prepare(
    "SELECT ts, spo2, rms, alarmA FROM telemetry ORDER BY ts DESC, id DESC LIMIT 1"
  ).all<any>();
  const row = (q.results && q.results[0]) ? q.results[0] : null;
  return json({ ok: true, point: row });
}

async function handleTelemetryDay(url: URL, env: Env) {
  const date = url.searchParams.get("date") || "";
  const rng = hanoiDayToUtcRange(date);
  if (!rng) return json({ ok:false, error:"bad_date" }, {status:400});

  const q = await env.DB.prepare(
    "SELECT ts, spo2, rms, alarmA FROM telemetry WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC"
  ).bind(rng.start, rng.end).all<any>();

  return json({ ok:true, tz:"Asia/Ho_Chi_Minh", date, points: q.results ?? [] });
}

async function handleTelemetryDays(url: URL, env: Env) {
  const datesCsv = url.searchParams.get("dates") || "";
  const dates = datesCsv.split(",").map(s => s.trim()).filter(Boolean).slice(0, 7);

  const out: Record<string, any[]> = {};
  for (const d of dates) {
    const rng = hanoiDayToUtcRange(d);
    if (!rng) continue;
    const q = await env.DB.prepare(
      "SELECT ts, spo2, rms, alarmA FROM telemetry WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC"
    ).bind(rng.start, rng.end).all<any>();
    out[d] = q.results ?? [];
  }

  return json({ ok:true, tz:"Asia/Ho_Chi_Minh", days: out });
}

async function handleUploadWav(req: Request, env: Env) {
  if (!isAuthorized(req, env)) return json({ ok: false, error: "unauthorized" }, { status: 401 });

  const filenameRaw = req.headers.get("X-Filename") || "abnormal.wav";
  const filename = safeFilename(filenameRaw);

  const nowSec = Math.floor(Date.now() / 1000);
  const ts = Number(req.headers.get("X-Timestamp") || nowSec);
  const tsUse = Number.isFinite(ts) && ts > 0 ? ts : nowSec;

  const buf = await req.arrayBuffer();
  const size = buf.byteLength;
  if (size < 44) return json({ ok:false, error:"file_too_small" }, { status: 400 });
  if (size > 25 * 1024 * 1024) return json({ ok:false, error:"file_too_large" }, { status: 413 });

  const dateStr = epochToHanoiDate(tsUse);
  const key = `abnormal/${dateStr}/${tsUse}_${filename}`;

  await env.AUDIO.put(key, buf, {
    httpMetadata: { contentType: "audio/wav" },
    customMetadata: { ts: String(tsUse), filename }
  });

  await env.DB.prepare(
    "INSERT OR IGNORE INTO abnormal_files (ts, r2_key, filename, size_bytes) VALUES (?, ?, ?, ?)"
  ).bind(tsUse, key, filename, size).run();

  await cleanupOld(env, nowSec);

  return json({ ok:true, key, ts: tsUse, filename, size_bytes: size });
}

async function handleAbnormalList(url: URL, env: Env) {
  const days = Math.min(7, Math.max(1, Number(url.searchParams.get("days") || 7)));
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * 24 * 3600;

  const q = await env.DB.prepare(
    "SELECT ts, r2_key, filename, size_bytes FROM abnormal_files WHERE ts >= ? ORDER BY ts DESC LIMIT 200"
  ).bind(cutoff).all<any>();

  return json({ ok:true, days, tz:"Asia/Ho_Chi_Minh", items: q.results ?? [] });
}

async function handleAbnormalGet(url: URL, env: Env) {
  const key = url.searchParams.get("key") || "";
  if (!key || !key.startsWith("abnormal/")) return json({ ok:false, error:"bad_key" }, { status: 400 });

  const obj = await env.AUDIO.get(key);
  if (!obj) return json({ ok:false, error:"not_found" }, { status: 404 });

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Content-Type", obj.httpMetadata?.contentType || "audio/wav");
  headers.set("Cache-Control", "public, max-age=300");

  const fname = obj.customMetadata?.filename || key.split("/").pop() || "abnormal.wav";
  headers.set("Content-Disposition", `inline; filename="${fname}"`);
  return new Response(obj.body, { headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename, X-Timestamp",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    if (url.pathname === "/" && req.method === "GET") {
      return json({ ok: true, service: "sleepmon-api", tz: "Asia/Ho_Chi_Minh" });
    }

    if (url.pathname === "/telemetry" && req.method === "POST") return handleTelemetryPost(req, env);
    if (url.pathname === "/telemetry/latest" && req.method === "GET") return handleTelemetryLatest(env);
    if (url.pathname === "/telemetry/day" && req.method === "GET") return handleTelemetryDay(url, env);
    if (url.pathname === "/telemetry/days" && req.method === "GET") return handleTelemetryDays(url, env);

    if (url.pathname === "/upload_wav" && req.method === "POST") return handleUploadWav(req, env);
    if (url.pathname === "/abnormal/list" && req.method === "GET") return handleAbnormalList(url, env);
    if (url.pathname === "/abnormal/get" && req.method === "GET") return handleAbnormalGet(url, env);

    return json({ ok:false, error:"not_found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx.waitUntil(cleanupOld(env, nowSec));
  }
};
