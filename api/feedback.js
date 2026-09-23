/* 제보하기 — 앱의 도착 완료 팝업에서 보내는 사용자 제보를 받아 저장한다.

   POST /api/feedback  (JSON)
     { kind: "trip", category: ["position"|"eta"|"route"|"notify"|"lockscreen"|"other", …],
       message: string(≤1000), trip: {from,to,legs:[{line,from,to}],elapsedMin,plannedMin,transfers,arrivedAt},
       app: {version, build, os, device} }
     → 200 {ok:true, id}   · 400 형식 오류 · 413 본문 8KB 초과 · 429 너무 잦음 · 500 저장 실패
   GET  /api/feedback?op=list&limit=50   헤더 x-cron-secret(api/la.js 의 cronSecret) — 최근 제보(개발자용)

   저장소: 기존 테이블 public.sf_cache (lib/supabase.js) — anon 키로 upsert 가능.
     date = 'ssl:fb:<ISO 시각>:<무작위 6자>' , events = { …검증된 본문, id, received_at, ip_hash }
   원래 IP 는 저장하지 않는다(ip_hash = sha256(ip + 'ssl-fb') 앞 12자, 같은 기기의 도배 여부만 가늠). */

const crypto = require("crypto");
const store = require("../lib/supabase");
const { cronSecret } = require("./la");

const PREFIX = "ssl:fb:";
const CATEGORIES = ["position", "eta", "route", "notify", "lockscreen", "other"];
const MAX_MESSAGE = 1000;
const MAX_BODY = 8 * 1024;
const RATE_MAX = 5;                       /* IP 하나당 */
const RATE_WINDOW_MS = 10 * 60 * 1000;    /* 10분에 */
const MAX_LEGS = 12;
const MAX_STR = 60;

/* 인스턴스 메모리 속 간단한 속도 제한(콜드 스타트마다 비워진다 — 도배 방지용으로 충분) */
const hits = new Map();

/* 제어 문자 제거. 여러 줄 입력이라 줄바꿈(\n)만 남기고 \r\n 은 \n 으로 */
function cleanText(v, max, { multiline = false } = {}) {
  if (typeof v !== "string") return "";
  let s = v.replace(/\r\n?/g, "\n");
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    : s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "");
  if (multiline) s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return Array.from(s).slice(0, max).join("");   /* 코드 포인트 기준으로 잘라 이모지가 깨지지 않게 */
}

const cleanInt = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

function cleanCategories(v) {
  const list = Array.isArray(v) ? v : (typeof v === "string" && v ? [v] : []);
  const out = [];
  for (const c of list) {
    if (typeof c !== "string" || !CATEGORIES.includes(c)) return null;   /* 모르는 키는 거절 */
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function cleanTrip(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const legs = (Array.isArray(t.legs) ? t.legs : []).slice(0, MAX_LEGS)
    .filter((g) => g && typeof g === "object")
    .map((g) => ({ line: cleanText(g.line, MAX_STR), from: cleanText(g.from, MAX_STR), to: cleanText(g.to, MAX_STR) }));
  return {
    from: cleanText(t.from, MAX_STR),
    to: cleanText(t.to, MAX_STR),
    legs,
    elapsedMin: cleanInt(t.elapsedMin, 0, 24 * 60),
    plannedMin: cleanInt(t.plannedMin, 0, 24 * 60),
    transfers: cleanInt(t.transfers, 0, 50),
    arrivedAt: cleanText(t.arrivedAt, 20),
  };
}

function cleanApp(a) {
  const o = a && typeof a === "object" && !Array.isArray(a) ? a : {};
  return { version: cleanText(o.version, 20), build: cleanText(o.build, 20), os: cleanText(o.os, 20), device: cleanText(o.device, 40) };
}

/** 본문 검증 → {ok:true, value} 또는 {ok:false, error} */
function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid body" };
  if (body.kind !== "trip") return { ok: false, error: "invalid kind" };
  const category = cleanCategories(body.category);
  if (!category) return { ok: false, error: "invalid category" };
  if (body.message != null && typeof body.message !== "string") return { ok: false, error: "invalid message" };
  const message = cleanText(body.message, MAX_MESSAGE, { multiline: true });
  if (!category.length && !message) return { ok: false, error: "empty feedback" };
  return { ok: true, value: { kind: "trip", category, message, trip: cleanTrip(body.trip), app: cleanApp(body.app) } };
}

function clientIp(req) {
  const h = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  const first = String(Array.isArray(h) ? h[0] : h).split(",")[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || "unknown";
}
const ipHash = (ip) => crypto.createHash("sha256").update(ip + "ssl-fb").digest("hex").slice(0, 12);

/** 속도 제한 — 허용되면 기록하고 true */
function rateOk(key, now = Date.now()) {
  const list = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {   /* 메모리 상한 — 오래된 키 정리 */
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= RATE_WINDOW_MS) hits.delete(k);
  }
  return true;
}

const randomId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join("");
};

function readBody(req) {
  const b = req.body;
  if (b == null || b === "") return { raw: "", body: null };
  if (typeof b === "string") { try { return { raw: b, body: JSON.parse(b) }; } catch (e) { return { raw: b, body: undefined }; } }
  if (Buffer.isBuffer(b)) { const s = b.toString("utf8"); try { return { raw: s, body: JSON.parse(s) }; } catch (e) { return { raw: s, body: undefined }; } }
  return { raw: JSON.stringify(b), body: b };
}

async function opSubmit(req, res) {
  const len = Number(req.headers && req.headers["content-length"]);
  if (Number.isFinite(len) && len > MAX_BODY) return res.status(413).json({ error: "payload too large" });
  const { raw, body } = readBody(req);
  if (Buffer.byteLength(raw || "", "utf8") > MAX_BODY) return res.status(413).json({ error: "payload too large" });
  if (body === undefined) return res.status(400).json({ error: "invalid json" });
  const v = validate(body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const hash = ipHash(clientIp(req));
  if (!rateOk(hash)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ error: "too many requests" });
  }

  const now = new Date();
  const id = randomId();
  const at = now.toISOString();
  const events = Object.assign({}, v.value, { id, received_at: at, ip_hash: hash });
  await store.sbUpsert(store.CACHE_TABLE, { date: `${PREFIX}${at}:${id}`, events, updated_at: at }, "date");
  return res.status(200).json({ ok: true, id });
}

async function opList(req, res) {
  if (req.headers["x-cron-secret"] !== cronSecret()) return res.status(401).json({ error: "unauthorized" });
  const limit = cleanInt((req.query && req.query.limit) || 50, 1, 200);
  const rows = await store.sbSelect(store.CACHE_TABLE,
    `date=like.${encodeURIComponent(PREFIX + "*")}&select=date,events,updated_at&order=date.desc&limit=${limit}`);
  const items = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.events && r.events.deleted !== true)
    .map((r) => Object.assign({ key: r.date }, r.events));
  return res.status(200).json({ ok: true, count: items.length, items });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(204).end();
    }
    const op = String((req.query && req.query.op) || "");
    if (req.method === "GET" && op === "list") return await opList(req, res);
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST, OPTIONS"); return res.status(405).json({ error: "POST required" }); }
    return await opSubmit(req, res);
  } catch (e) {
    console.error("[feedback]", (e && e.message) || e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "server" });
  }
};

module.exports.CATEGORIES = CATEGORIES;
module.exports.validate = validate;
module.exports.cleanText = cleanText;
module.exports.ipHash = ipHash;
module.exports.rateOk = rateOk;
/* 테스트 전용 — 속도 제한 기록 초기화 */
module.exports._resetRate = () => hits.clear();
