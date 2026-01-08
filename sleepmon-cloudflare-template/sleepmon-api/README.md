# sleepmon-api (Cloudflare Worker)

Public:
- GET /api/public/events?limit=50
- GET /api/public/audio/<upload_id>

Device (HMAC):
- POST /api/device/event
- POST /api/device/upload_init
- PUT  /api/device/upload/<upload_id>

Auth headers:
- X-Device-Id, X-Ts, X-Nonce, X-Signature

canonical:
METHOD\nPATH\nX-Ts\nX-Nonce\nSHA256(body)
