export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  // Set as a Worker secret: JSON string like {"dev01":"<secret1>","dev02":"<secret2>"}
  DEVICE_SECRETS_JSON: string;
  // Optional: tighten CORS for your dashboard origin, e.g. "https://sleepmon-web.pages.dev"
  DASHBOARD_ORIGIN?: string;
}

type Json = Record<string, unknown>;

function json(res: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(res, null, 2), { ...init, headers });
}

function badRequest(message: string, extra: Json = {}) {
  return json({ ok: false, error: "bad_request", message, ...extra }, { status: 400 });
}
function unauthorized(message: string, extra: Json = {}) {
  return json({ ok: false, error: "unauthorized", message, ...extra }, { status: 401 });
}
function notFound() {
  return json({ ok: false, error: "not_found" }, { status: 404 });
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCorsHeaders(env: Env, isPublic: boolean): HeadersInit {
  const origin = env.DASHBOARD_ORIGIN?.trim();
  const allowOrigin = isPublic ? "*" : (origin && origin.length > 0 ? origin : "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,X-Device-Id,X-Ts,X-Nonce,X-Content-Sha256,X-Signature",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleOptions(env: Env, isPublic: boolean) {
  return new Response(null, { status: 204, headers: getCorsHeaders(env, isPublic) });
}

function parsePath(url: URL): string[] {
  return url.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function verifyDeviceAuth(
  request: Request,
  env: Env,
  bodyHashHex: string
): Promise<{ ok: true; deviceId: string } | { ok: false; resp: Response }> {
  const deviceId = request.headers.get("X-Device-Id")?.trim() || "";
  const tsStr = request.headers.get("X-Ts")?.trim() || "";
  const nonce = request.headers.get("X-Nonce")?.trim() || "";
  const sig = request.headers.get("X-Signature")?.trim() || "";

  if (!deviceId || !tsStr || !nonce || !sig) {
    return {
      ok: false,
      resp: unauthorized(
        "Missing auth headers. Need X-Device-Id, X-Ts, X-Nonce, X-Signature."
      ),
    };
  }

  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) {
    return { ok: false, resp: unauthorized("X-Ts must be a unix timestamp (seconds).") };
  }

  // Basic anti-replay window (± 120s)
  const skew = Math.abs(nowSec() - ts);
  if (skew > 120) {
    return { ok: false, resp: unauthorized("Timestamp out of range.", { skew_seconds: skew }) };
  }

  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(env.DEVICE_SECRETS_JSON || "{}");
  } catch {
    return {
      ok: false,
      resp: unauthorized("Server misconfigured: DEVICE_SECRETS_JSON is not valid JSON."),
    };
  }
  const secret = secrets[deviceId];
  if (!secret) {
    return { ok: false, resp: unauthorized("Unknown device_id.") };
  }

  const url = new URL(request.url);
  const canonical = [request.method.toUpperCase(), url.pathname, tsStr, nonce, bodyHashHex].join("\n");
  const expected = await hmacHex(secret, canonical);

  if (!safeEqualHex(expected, sig.toLowerCase())) {
    return { ok: false, resp: unauthorized("Invalid signature.") };
  }

  // Replay protection: store nonce
  try {
    const cutoff = nowSec() - 600; // keep 10 minutes
    await env.DB.prepare("DELETE FROM nonces WHERE ts < ?").bind(cutoff).run();

    const ins = await env.DB
      .prepare("INSERT OR IGNORE INTO nonces(device_id, nonce, ts) VALUES (?,?,?)")
      .bind(deviceId, nonce, ts)
      .run();

    // @ts-expect-error meta exists at runtime
    if (ins.meta?.changes === 0) {
      return { ok: false, resp: unauthorized("Replay detected (nonce already used).") };
    }
  } catch (e: any) {
    return {
      ok: false,
      resp: unauthorized("Nonce check failed.", { detail: String(e?.message || e) }),
    };
  }

  return { ok: true, deviceId };
}

function uuid(): string {
  return crypto.randomUUID();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = parsePath(url);

    const isPublic = path[0] === "api" && path[1] === "public";
    const isDevice = path[0] === "api" && path[1] === "device";

    if (request.method === "OPTIONS") {
      return await handleOptions(env, isPublic);
    }

    if (path.length === 0) {
      return json(
        { ok: true, service: "sleepmon-api", routes: ["/api/public/*", "/api/device/*"] },
        { headers: getCorsHeaders(env, true) }
      );
    }

    // -------- Public API --------
    if (isPublic) {
      if (request.method === "GET" && path[2] === "events") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || "50")));
        const typesParam = url.searchParams.get("types") || url.searchParams.get("type") || "";
        const types = typesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n));
        const res = await env.DB.prepare(
          `SELECT id, device_id, type, severity, ts_start, ts_end, spo2_min, spo2_avg, hr_avg, audio_upload_id, meta_json, created_at
           FROM events
           ORDER BY created_at DESC
           LIMIT ?`
        )
          .bind(limit)
          .all();

        // @ts-expect-error results exists at runtime
        const rows = res.results || [];
        const events = rows.map((r: any) => ({
          ...r,
          meta: r.meta_json ? safeJsonParse(r.meta_json) : null,
          audio_url: r.audio_upload_id
            ? `${url.origin}/api/public/audio/${encodeURIComponent(r.audio_upload_id)}`
            : null,
        }));

        return json({ ok: true, events }, { headers: getCorsHeaders(env, true) });
      }

      if (request.method === "GET" && path[2] === "audio" && path[3]) {
        const uploadId = decodeURIComponent(path[3]);
        const u = await env.DB.prepare("SELECT r2_key, content_type, status FROM uploads WHERE upload_id = ?")
          .bind(uploadId)
          .first();

        if (!u || (u as any).status !== "complete") return notFound();

        const obj = await env.AUDIO.get((u as any).r2_key);
        if (!obj) return notFound();

        const headers = new Headers(getCorsHeaders(env, true));
        headers.set("Content-Type", (u as any).content_type || "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(obj.body, { status: 200, headers });
      }

      return notFound();
    }

    // -------- Device API --------
    if (isDevice) {
      // NOTE: This reads the full body into memory. Keep audio clips small.
      const bodyBuf = await request.arrayBuffer();
      const bodyHash = await sha256Hex(bodyBuf);

      const auth = await verifyDeviceAuth(request, env, bodyHash);
      if (!auth.ok) return withCors(env, auth.resp, false);
      const deviceId = auth.deviceId;

      if (request.method === "POST" && path[2] === "event") {
        let payload: any;
        try {
          payload = JSON.parse(new TextDecoder().decode(bodyBuf));
        } catch {
          return withCors(env, badRequest("Invalid JSON body."), false);
        }

        const {
          id = uuid(),
          type = "unknown",
          severity = 0,
          ts_start,
          ts_end = null,
          spo2_min = null,
          spo2_avg = null,
          hr_avg = null,
          audio_upload_id = null,
          // Accept both 'meta' and legacy 'meta_raw' from devices
          meta = (payload && (payload.meta ?? payload.meta_raw)) ?? null,
        } = payload || {};

        if (!ts_start || !Number.isFinite(Number(ts_start))) {
          return withCors(env, badRequest("ts_start is required (unix seconds)."), false);
        }

        const createdAt = nowSec();
        const metaJson = meta ? JSON.stringify(meta) : null;

        await env.DB.prepare(
          `INSERT INTO events (id, device_id, type, severity, ts_start, ts_end, spo2_min, spo2_avg, hr_avg, audio_upload_id, meta_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
          .bind(
            String(id),
            deviceId,
            String(type),
            Number(severity),
            Number(ts_start),
            ts_end === null ? null : Number(ts_end),
            spo2_min === null ? null : Number(spo2_min),
            spo2_avg === null ? null : Number(spo2_avg),
            hr_avg === null ? null : Number(hr_avg),
            audio_upload_id ? String(audio_upload_id) : null,
            metaJson,
            createdAt
          )
          .run();

        return withCors(env, json({ ok: true, id: String(id) }), false);
      }

      if (request.method === "POST" && path[2] === "upload_init") {
        let payload: any;
        try {
          payload = JSON.parse(new TextDecoder().decode(bodyBuf));
        } catch {
          return withCors(env, badRequest("Invalid JSON body."), false);
        }

        const { filename = `${uuid()}.wav`, size, sha256, content_type = "audio/wav" } = payload || {};

        if (!size || !Number.isFinite(Number(size))) return withCors(env, badRequest("size is required."), false);
        if (!sha256 || typeof sha256 !== "string" || sha256.length < 16)
          return withCors(env, badRequest("sha256 is required."), false);

        const uploadId = uuid();
        const createdAt = nowSec();
        const date = new Date(createdAt * 1000).toISOString().slice(0, 10);
        const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const r2Key = `${deviceId}/${date}/${uploadId}_${safeName}`;

        await env.DB.prepare(
          `INSERT INTO uploads (upload_id, device_id, r2_key, size, sha256, content_type, status, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
          .bind(uploadId, deviceId, r2Key, Number(size), sha256.toLowerCase(), String(content_type), "init", createdAt)
          .run();

        const putUrl = `${url.origin}/api/device/upload/${encodeURIComponent(uploadId)}`;
        return withCors(env, json({ ok: true, upload_id: uploadId, r2_key: r2Key, put_url: putUrl }), false);
      }

      if (request.method === "PUT" && path[2] === "upload" && path[3]) {
        const uploadId = decodeURIComponent(path[3]);

        const rec = await env.DB.prepare(
          "SELECT upload_id, device_id, r2_key, size, sha256, content_type, status FROM uploads WHERE upload_id = ?"
        )
          .bind(uploadId)
          .first();

        if (!rec) return withCors(env, notFound(), false);
        if ((rec as any).device_id !== deviceId) return withCors(env, unauthorized("upload_id does not belong to device."), false);
        if ((rec as any).status !== "init") return withCors(env, badRequest("upload not in init state."), false);

        const maxBytes = 8 * 1024 * 1024; // 8MB safety limit (demo)
        if (bodyBuf.byteLength > maxBytes) {
          return withCors(env, badRequest("Audio too large for this demo. Split to smaller clips (<=8MB).", { max_bytes: maxBytes }), false);
        }

        if (Number((rec as any).size) !== bodyBuf.byteLength) {
          return withCors(env, badRequest("size mismatch", { expected: Number((rec as any).size), got: bodyBuf.byteLength }), false);
        }

        const gotSha = await sha256Hex(bodyBuf);
        if (!safeEqualHex(gotSha, String((rec as any).sha256).toLowerCase())) {
          return withCors(env, badRequest("sha256 mismatch", { got: gotSha }), false);
        }

        await env.AUDIO.put(String((rec as any).r2_key), bodyBuf, {
          httpMetadata: { contentType: String((rec as any).content_type || "application/octet-stream") },
        });

        await env.DB.prepare("UPDATE uploads SET status = 'complete' WHERE upload_id = ?").bind(uploadId).run();
        return withCors(env, json({ ok: true, upload_id: uploadId }), false);
      }

      return withCors(env, notFound(), false);
    }

    return notFound();
  },
};

function withCors(env: Env, resp: Response, isPublic: boolean): Response {
  const headers = new Headers(resp.headers);
  const cors = getCorsHeaders(env, isPublic);
  Object.entries(cors).forEach(([k, v]) => headers.set(k, String(v)));
  return new Response(resp.body, { status: resp.status, headers });
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}