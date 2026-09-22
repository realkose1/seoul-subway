/* 라이브 액티비티(주행 안내) 서버 — APNs 푸시로 잠금화면을 갱신한다.
   UIBackgroundModes: location(위치 keep-alive)을 대신하는 정식 방식:
     앱이 pushType: .token 으로 액티비티를 시작 → 토큰+주행 정보를 여기로 보냄(op=register)
     → Supabase pg_cron 이 1분(또는 30초)마다 op=tick 을 때리면 서버가 열차를 따라가며 푸시.

   op 라우팅:
     POST ?op=register  {tripId, token, env, attrs, state, track, paused}
     POST ?op=update    같은 형식(부분 허용) — 앱이 포그라운드면 paused:true 로 서버 푸시를 멈춘다
     POST ?op=end       {tripId, local} — local:false 면 end 푸시까지 보내고 행 삭제
     GET  ?op=tick      헤더 x-cron-secret: LA_CRON_SECRET (dry=1 이면 계산만)

   환경변수: APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID,
             SUPABASE_URL, SUPABASE_SERVICE_KEY, LA_CRON_SECRET, SUBWAY_API_KEY */

const { fetchLinePositions } = require("../lib/position-feed");
const { computeRow } = require("../lib/la-core");
const { createPusher, isDeadToken } = require("../lib/apns");
const { sbSelect, sbUpsert, sbPatch, sbDelete } = require("../lib/supabase");

const TABLE = "ssl_live_trips";
const TRIP_TTL_MS = 3 * 60 * 60 * 1000;   /* 행 수명 3시간 — 앱이 죽어도 영원히 푸시하지 않도록 */
const MAX_ROWS = 50;                      /* 한 틱에서 처리할 최대 행 수(10초 예산) */
const DISMISS_AFTER_SEC = 8;

const iso = (ms) => new Date(ms).toISOString();

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/* ── op=register / op=update ─────────────────────────────────────────────── */
async function opRegister(req, res, { isUpdate }) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  if (!isUpdate && !b.token) return res.status(400).json({ error: "token required" });

  const now = Date.now();
  const row = { trip_id: tripId, updated_at: iso(now) };
  if (b.token != null) row.token = String(b.token);
  if (b.env != null) row.env = b.env === "sandbox" ? "sandbox" : "prod";
  if (b.attrs != null) row.attrs = b.attrs;
  if (b.state != null) row.state = b.state;
  if (b.track !== undefined) row.track = b.track || null;
  if (b.paused != null) row.paused = !!b.paused;

  if (!isUpdate) {
    row.env = row.env || "prod";
    row.paused = row.paused != null ? row.paused : false;
    row.attrs = row.attrs || {};
    row.state = row.state || {};
    row.expires_at = iso(now + TRIP_TTL_MS);
    row.last_feed_at = null;
    row.last_push_at = null;
  } else {
    row.expires_at = iso(now + TRIP_TTL_MS);   /* 살아 있다는 신호 = 수명 연장 */
  }

  if (isUpdate) {
    const patched = await sbPatch(TABLE, `trip_id=eq.${encodeURIComponent(tripId)}`, row);
    if (Array.isArray(patched) && patched.length) return res.status(200).json({ ok: true, updated: true });
    if (!row.token) return res.status(404).json({ error: "unknown tripId (send op=register first)" });
    /* 행이 없어졌다면(만료·정리) register 와 같게 다시 만든다 */
    row.env = row.env || "prod";
    row.paused = row.paused != null ? row.paused : false;
    row.attrs = row.attrs || {};
    row.state = row.state || {};
  }
  await sbUpsert(TABLE, row, "trip_id");
  return res.status(200).json({ ok: true, created: !isUpdate });
}

/* ── op=end ──────────────────────────────────────────────────────────────── */
async function opEnd(req, res) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  const local = !!b.local;

  let pushed = false;
  if (!local) {
    const rows = await sbSelect(TABLE, `trip_id=eq.${encodeURIComponent(tripId)}&select=*`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.token) {
      const pusher = createPusher();
      try {
        const st = Object.assign({}, row.state || {}, { done: true, waiting: false, alight: false });
        const r = await pusher.send({
          token: row.token, env: row.env, contentState: st, event: "end", priority: 10,
          dismissalSec: Math.floor(Date.now() / 1000) + DISMISS_AFTER_SEC, staleSec: 300,
        });
        pushed = r.status === 200;
        if (!pushed) console.warn("[la] end push", r.status, r.reason);
      } finally { pusher.close(); }
    }
  }
  await sbDelete(TABLE, `trip_id=eq.${encodeURIComponent(tripId)}`);
  return res.status(200).json({ ok: true, pushed });
}

/* ── op=tick ─────────────────────────────────────────────────────────────── */
async function opTick(req, res) {
  const secret = process.env.LA_CRON_SECRET;
  if (!secret || req.headers["x-cron-secret"] !== secret) return res.status(401).json({ error: "unauthorized" });
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const now = Date.now();

  const rows = await sbSelect(TABLE,
    `select=*&paused=is.false&expires_at=gt.${encodeURIComponent(iso(now))}&order=updated_at.asc&limit=${MAX_ROWS}`);
  if (!Array.isArray(rows) || !rows.length) return res.status(200).json({ rows: 0, pushed: 0, ended: 0, errors: 0 });

  /* 필요한 노선을 모아 한 번씩만 조회한다(행마다 부르지 않는다) */
  const lines = new Set();
  for (const r of rows) {
    const t = r.track;
    if (!t || !t.no) continue;
    if (t.line) lines.add(t.line);
    const legs = Array.isArray(t.legs) ? t.legs : [];
    const nl = legs[(Number(t.legIdx) || 0) + 1];
    if (t.legEndedAt && nl && nl.line) lines.add(nl.line);   /* 환승 대기 → 다음 구간 노선도 본다 */
  }
  const feedMap = new Map();
  await Promise.all([...lines].map(async (ln) => {
    feedMap.set(ln, await fetchLinePositions(ln, { timeoutMs: 5000, maxAgeMs: 4000 }));
  }));
  const feed = (ln) => feedMap.get(ln) || [];

  const results = rows.map((r) => { try { return computeRow(r, feed, now); } catch (e) { console.warn("[la] compute", r.trip_id, e && e.message); return null; } });

  if (dry) {
    return res.status(200).json({
      dry: true, rows: rows.length, lines: [...lines],
      results: results.filter(Boolean).map((x) => ({
        tripId: x.tripId, note: x.note, changed: x.changed, remove: x.remove,
        push: x.push ? { event: x.push.event, priority: x.push.priority, alert: x.push.alert } : null,
        state: x.state, track: x.track ? { no: x.track.no, line: x.track.line, legIdx: x.track.legIdx, legEndedAt: x.track.legEndedAt || null } : null,
      })),
    });
  }

  let pushed = 0, ended = 0, errors = 0;
  const dead = [], remove = [], save = [];
  const pusher = createPusher();
  try {
    await Promise.all(results.filter(Boolean).map(async (x) => {
      if (x.push && x.token) {
        const r = await pusher.send({
          token: x.token, env: x.env, contentState: x.state, event: x.push.event,
          priority: x.push.priority, alert: x.push.alert,
          dismissalSec: x.push.dismissalSec, staleSec: x.push.staleSec,
        });
        if (r.status === 200) { pushed++; if (x.push.event === "end") ended++; }
        else if (isDeadToken(r)) { dead.push(x.tripId); errors++; console.warn("[la] dead token", x.tripId, r.status, r.reason); }
        else { errors++; console.warn("[la] push fail", x.tripId, r.status, r.reason); }
      }
      if (x.remove) remove.push(x.tripId);
      else if (!dead.includes(x.tripId)) {
        save.push({
          trip_id: x.tripId,
          state: x.state,
          track: x.track,
          last_push_at: x.push ? iso(now) : (rows.find((r) => r.trip_id === x.tripId) || {}).last_push_at || null,
          last_feed_at: iso(now),
          updated_at: iso(now),
        });
      }
    }));
  } finally { pusher.close(); }

  const gone = [...new Set(remove.concat(dead))];
  await Promise.all([
    gone.length ? sbDelete(TABLE, `trip_id=in.(${gone.map((t) => `"${t}"`).join(",")})`).catch((e) => console.warn("[la] delete", e.message)) : null,
    save.filter((s) => !gone.includes(s.trip_id)).length
      ? sbUpsert(TABLE, save.filter((s) => !gone.includes(s.trip_id)), "trip_id").catch((e) => console.warn("[la] save", e.message))
      : null,
  ].filter(Boolean));

  return res.status(200).json({ rows: rows.length, pushed, ended, errors });
}

/* ── 라우팅 ──────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const op = String((req.query && req.query.op) || "");
  try {
    if (op === "tick") return await opTick(req, res);
    if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
    if (op === "register") return await opRegister(req, res, { isUpdate: false });
    if (op === "update") return await opRegister(req, res, { isUpdate: true });
    if (op === "end") return await opEnd(req, res);
    return res.status(400).json({ error: "unknown op (register|update|end|tick)" });
  } catch (e) {
    console.error("[la]", op, e && e.stack || e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "server", message: String((e && e.message) || e) });
  }
};

module.exports.TABLE = TABLE;
module.exports.TRIP_TTL_MS = TRIP_TTL_MS;
