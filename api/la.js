/* 라이브 액티비티(주행 안내) 서버 — APNs 푸시로 잠금화면을 갱신한다.
   UIBackgroundModes: location(위치 keep-alive)을 대신하는 정식 방식:
     앱이 pushType: .token 으로 액티비티를 시작 → 토큰+주행 정보를 여기로 보냄(op=register)
     → 서버가 열차를 따라가며 ActivityKit 업데이트를 푸시.

   스케줄러는 **자기 호출 체인**이다(Vercel Hobby 는 분 단위 크론이 없다):
     register/update(paused:false) 가 체인을 띄우고 → 틱이 일을 마친 뒤 ~50초를 기다렸다가
     자기 자신(op=tick&chain=1)을 호출한다. 활성 주행이 하나도 없으면 체인이 멈추고
     잠금이 풀린다. 외부 크론이 그냥 op=tick 을 때리는 예전 방식도 그대로 동작한다.

   저장소는 기존 테이블 public.sf_cache (lib/supabase.js 참고) — SQL 실행이 필요 없다.

   op 라우팅:
     POST ?op=register  {tripId, token, env, attrs, state, track, paused}
     POST ?op=update    같은 형식(부분 허용) — 앱이 포그라운드면 paused:true 로 서버 푸시를 멈춘다
     POST ?op=end       {tripId, local}
     GET  ?op=tick      헤더 x-cron-secret (chain=1 이면 체인 모드, dry=1 이면 계산만)

   환경변수: APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, SUPABASE_URL,
             SUPABASE_SERVICE_KEY 또는 SUPABASE_ANON_KEY(또는 SUPABASE_ANON_FALLBACK),
             SUBWAY_API_KEY / (선택) LA_CRON_SECRET, LA_SELF_URL, LA_TABLE */

const crypto = require("crypto");
const { fetchLinePositions } = require("../lib/position-feed");
const { computeRow } = require("../lib/la-core");
const { createPusher, isDeadToken } = require("../lib/apns");
const store = require("../lib/supabase");

const TRIP_TTL_MS = 3 * 60 * 60 * 1000;   /* 행 수명 3시간 — 앱이 죽어도 영원히 푸시하지 않도록 */
const MAX_ROWS = 50;                      /* 한 틱에서 처리할 최대 행 수 */
const DISMISS_AFTER_SEC = 8;
const CHAIN_ROUND_MS = 50 * 1000;         /* 이 시각(호출 시작 기준)에 다음 틱을 띄운다 */
const CHAIN_RACE_MS = 1500;               /* 다음 틱 호출은 이만큼만 기다리고 응답한다 */
const LOCK_TTL_MS = 75 * 1000;            /* 체인 잠금 임대 — 한 라운드(60초)보다 넉넉히 */

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 틱 인증. LA_CRON_SECRET 를 직접 정하는 쪽이 낫지만, 없으면 APNs 키 식별자에서 유도해
   체인이 추가 설정 없이 스스로를 인증할 수 있게 한다(값 자체는 밖으로 나가지 않는다). */
function cronSecret() {
  if (process.env.LA_CRON_SECRET) return process.env.LA_CRON_SECRET;
  return crypto.createHash("sha256")
    .update(`${process.env.APNS_KEY_ID || ""}|${process.env.APNS_TEAM_ID || ""}`)
    .digest("hex");
}

function selfUrl() {
  if (process.env.LA_SELF_URL) return String(process.env.LA_SELF_URL).replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "https://seoul-subway-lyart.vercel.app";
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/* 다음 틱을 띄우고 잠깐만 기다린다 — 다음 호출은 독립적으로 돌아간다 */
async function triggerTick(cid) {
  const url = `${selfUrl()}/api/la?op=tick&chain=1&cid=${encodeURIComponent(cid)}`;
  const p = fetch(url, { headers: { "x-cron-secret": cronSecret() } }).catch((e) => console.warn("[la] chain call", e && e.message));
  await Promise.race([p, sleep(CHAIN_RACE_MS)]);
}

/* 체인이 안 돌고 있으면 새로 띄운다(register/update 에서 호출) */
async function kickChain() {
  try {
    const now = Date.now();
    const lock = await store.getLock();
    if (!store.lockFree(lock, now)) return false;      /* 이미 누가 돌고 있다 */
    const cid = crypto.randomUUID();
    await store.setLock(cid, now + LOCK_TTL_MS, now);
    await triggerTick(cid);
    return true;
  } catch (e) {
    console.warn("[la] kick", e && e.message);
    return false;
  }
}

/* ── op=register / op=update ─────────────────────────────────────────────── */
async function opRegister(req, res, { isUpdate }) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  if (!isUpdate && !b.token) return res.status(400).json({ error: "token required" });

  const now = Date.now();
  const patch = { trip_id: tripId, expires_at: iso(now + TRIP_TTL_MS) };   /* 살아 있다는 신호 = 수명 연장 */
  if (b.token != null) patch.token = String(b.token);
  if (b.env != null) patch.env = b.env === "sandbox" ? "sandbox" : "prod";
  if (b.attrs != null) patch.attrs = b.attrs;
  if (b.state != null) patch.state = b.state;
  if (b.track !== undefined) patch.track = b.track || null;
  if (b.paused != null) patch.paused = !!b.paused;

  let row = null, created = false;
  if (isUpdate) row = await store.patchTrip(tripId, patch, now);
  if (!row) {
    if (!patch.token) return res.status(404).json({ error: "unknown tripId (send op=register first)" });
    row = Object.assign({
      trip_id: tripId, env: "prod", attrs: {}, state: {}, track: null, paused: false,
      last_push_at: null, last_feed_at: null,
    }, patch);
    await store.saveTrips([row], now);
    created = true;
  }

  /* 서버가 갱신해야 하는 상태(paused:false)면 체인이 돌고 있는지 확인하고 없으면 띄운다 */
  const kicked = row.paused === false ? await kickChain() : false;
  return res.status(200).json({ ok: true, created, paused: !!row.paused, kicked });
}

/* ── op=end ──────────────────────────────────────────────────────────────── */
async function opEnd(req, res) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  const local = !!b.local;

  let pushed = false;
  if (!local) {
    const row = await store.getTrip(tripId);
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
  await store.deleteTrips([tripId]);
  return res.status(200).json({ ok: true, pushed });
}

/* ── op=tick ─────────────────────────────────────────────────────────────── */
async function opTick(req, res) {
  const startedAt = Date.now();
  if (req.headers["x-cron-secret"] !== cronSecret()) return res.status(401).json({ error: "unauthorized" });

  const dry = req.query.dry === "1" || req.query.dry === "true";
  const chain = req.query.chain === "1" || req.query.chain === "true";
  const cid = String(req.query.cid || "") || crypto.randomUUID();
  const now = startedAt;

  /* 체인은 한 줄만 돈다 — 잠금이 남의 것이고 아직 살아 있으면 이 호출은 조용히 물러난다 */
  if (chain) {
    const lock = await store.getLock();
    if (!store.lockOwned(lock, cid, now)) {
      return res.status(200).json({ rows: 0, pushed: 0, ended: 0, errors: 0, skipped: "locked" });
    }
    if (!dry) await store.setLock(cid, now + LOCK_TTL_MS, now);
  }

  const all = await store.listTrips();
  const active = store.activeTrips(all, now);
  const rows = active.slice(0, MAX_ROWS);

  if (!rows.length) {
    if (chain && !dry) await store.clearLock().catch(() => {});
    return res.status(200).json({ rows: 0, pushed: 0, ended: 0, errors: 0, chain: chain ? { cid, remaining: 0, next: false } : undefined });
  }

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

  const results = rows.map((r) => {
    try { return computeRow(r, feed, now); }
    catch (e) { console.warn("[la] compute", r.trip_id, e && e.message); return null; }
  });

  if (dry) {
    return res.status(200).json({
      dry: true, rows: rows.length, active: active.length, lines: [...lines],
      results: results.filter(Boolean).map((x) => ({
        tripId: x.tripId, note: x.note, changed: x.changed, remove: x.remove,
        push: x.push ? { event: x.push.event, priority: x.push.priority, alert: x.push.alert } : null,
        state: x.state,
        track: x.track ? { no: x.track.no, line: x.track.line, legIdx: x.track.legIdx, legEndedAt: x.track.legEndedAt || null } : null,
      })),
    });
  }

  let pushed = 0, ended = 0, errors = 0;
  const dead = [], remove = [], save = [];
  const byId = new Map(rows.map((r) => [r.trip_id, r]));
  const pusher = createPusher();
  try {
    await Promise.all(results.filter(Boolean).map(async (x) => {
      let isDead = false;
      if (x.push && x.token) {
        const r = await pusher.send({
          token: x.token, env: x.env, contentState: x.state, event: x.push.event,
          priority: x.push.priority, alert: x.push.alert,
          dismissalSec: x.push.dismissalSec, staleSec: x.push.staleSec,
        });
        if (r.status === 200) { pushed++; if (x.push.event === "end") ended++; }
        else if (isDeadToken(r)) { isDead = true; dead.push(x.tripId); errors++; console.warn("[la] dead token", x.tripId, r.status, r.reason); }
        else { errors++; console.warn("[la] push fail", x.tripId, r.status, r.reason); }
      }
      if (x.remove || isDead) { if (!isDead) remove.push(x.tripId); return; }
      save.push(Object.assign({}, byId.get(x.tripId), {
        state: x.state,
        track: x.track,
        last_push_at: x.push ? iso(now) : (byId.get(x.tripId) || {}).last_push_at || null,
        last_feed_at: iso(now),
      }));
    }));
  } finally { pusher.close(); }

  const gone = [...new Set(remove.concat(dead))];
  await Promise.all([
    gone.length ? store.deleteTrips(gone).catch((e) => console.warn("[la] delete", e.message)) : null,
    save.length ? store.saveTrips(save, now).catch((e) => console.warn("[la] save", e.message)) : null,
  ].filter(Boolean));

  /* ── 체인: 남은 주행이 있으면 ~50초 뒤 다음 틱을 띄운다 ── */
  const remaining = Math.max(0, active.length - gone.length);
  let next = false;
  if (chain) {
    if (remaining > 0) {
      await sleep(Math.max(0, CHAIN_ROUND_MS - (Date.now() - startedAt)));
      await store.setLock(cid, Date.now() + LOCK_TTL_MS).catch(() => {});
      await triggerTick(cid);
      next = true;
    } else {
      await store.clearLock().catch(() => {});
    }
  }

  return res.status(200).json({ rows: rows.length, pushed, ended, errors, chain: chain ? { cid, remaining, next } : undefined });
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
    console.error("[la]", op, (e && e.stack) || e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "server", message: String((e && e.message) || e) });
  }
};

module.exports.TRIP_TTL_MS = TRIP_TTL_MS;
module.exports.CHAIN_ROUND_MS = CHAIN_ROUND_MS;
module.exports.LOCK_TTL_MS = LOCK_TTL_MS;
module.exports.cronSecret = cronSecret;
module.exports.selfUrl = selfUrl;
