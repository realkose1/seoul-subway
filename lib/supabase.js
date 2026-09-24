/* Supabase 접근 — 주행 라이브 액티비티 행 저장소.
 *
 * 기본 저장소는 **기존 테이블 public.sf_cache** 다(SQL 실행·pg_cron 설정 없이 바로 쓰려고).
 * 그 앱이 쓰던 키/값 캐시 테이블이고 컬럼은 (date text pk, events jsonb, updated_at timestamptz),
 * RLS 가 anon 에게 select/upsert/delete 를 허용한다.
 *   주행 1건  →  date = 'ssl:la:<tripId>' , events = { tripId, token, env, attrs, state, track,
 *                                                     paused, last_push_at, last_feed_at, last_progress_at, expires_at }
 *   체인 잠금 →  date = 'ssl:la:lock'     , events = { until, id }
 *   노선 관측 이력 → date = 'ssl:la:hist:<노선>', events = { trains, at }  (lib/train-hist.js — 운행 대기·탄 열차 교체 판정)
 *   운행 대기 등록부 → date = 'ssl:la:parked', events = { trains: {"노선|번호": {line,no,stn,since,lastSeen}}, lines, at }  (6시간)
 * 접두사를 쓰므로 그 앱의 날짜 행('2026-09-22')·라인업 행('af-lineup-…')과 섞이지 않는다.
 *
 * 전용 테이블(db/live_activity.sql 의 ssl_live_trips)을 만들었다면 환경변수
 * LA_TABLE=ssl_live_trips 를 주면 그쪽(컬럼형)으로 동작한다.
 *
 * 키: SUPABASE_SERVICE_KEY → SUPABASE_ANON_KEY → SUPABASE_ANON_FALLBACK (모두 환경변수. 코드에 키를 넣지 않는다) */

const PREFIX = "ssl:la:";
const LOCK_KEY = `${PREFIX}lock`;
const HIST_PREFIX = `${PREFIX}hist:`;
const PARKED_KEY = `${PREFIX}parked`;
const CACHE_TABLE = "sf_cache";

const apiKey = () =>
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_FALLBACK || PUBLIC_ANON_KEY;

const sbHeaders = () => ({
  apikey: apiKey(),
  authorization: `Bearer ${apiKey()}`,
  "content-type": "application/json",
});

/* 공개 anon 키(클라이언트에도 노출되는 공개값) — sf_cache는 anon 정책으로 읽기/쓰기 가능. service_role 키가 있으면 그것을 우선 사용 */
const PUBLIC_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4Y2htb2xjcnVoeGJtdm9tc3l5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTk0ODgsImV4cCI6MjA5MzMzNTQ4OH0.WvxjnCkWD_LCgJTPdH3jtMc-maz0dSgS-A9SDHuy58U";
const base = () => `${process.env.SUPABASE_URL}/rest/v1`;

/* 전용 테이블 모드인지 (기본: sf_cache) */
const dedicatedTable = () => process.env.LA_TABLE || null;

async function sbFetch(path, init) {
  const r = await fetch(`${base()}/${path}`, Object.assign({ headers: sbHeaders() }, init));
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`supabase ${r.status} ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

/* ── 범용 REST 헬퍼(전용 테이블 모드와 디버깅용) ──────────────────────────── */
async function sbSelect(table, query) {
  const r = await sbFetch(`${table}?${query}`, { method: "GET" });
  return r.json().catch(() => []);
}
async function sbUpsert(table, rows, onConflict) {
  const r = await sbFetch(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  return r.json().catch(() => []);
}
async function sbPatch(table, query, patch) {
  const r = await sbFetch(`${table}?${query}`, {
    method: "PATCH",
    headers: Object.assign(sbHeaders(), { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  return r.json().catch(() => []);
}
async function sbDelete(table, query) {
  await sbFetch(`${table}?${query}`, { method: "DELETE", headers: sbHeaders() });
}

/* ── sf_cache ↔ 주행 행 매핑 ─────────────────────────────────────────────── */
const ROW_KEYS = ["trip_id", "token", "env", "attrs", "state", "track", "paused", "last_push_at", "last_feed_at", "last_progress_at", "expires_at"];

/* sf_cache 행 → 컬럼형 행(코드의 나머지 부분은 이 모양만 안다) */
function toTrip(cacheRow) {
  if (!cacheRow || typeof cacheRow.date !== "string" || !cacheRow.date.startsWith(PREFIX)) return null;
  if (cacheRow.date === LOCK_KEY || cacheRow.date === PARKED_KEY || cacheRow.date.startsWith(HIST_PREFIX)) return null;
  const e = cacheRow.events || {};
  if (e.deleted === true) return null;   /* 소프트 삭제된 행 = 없는 것 */
  return {
    trip_id: e.tripId || cacheRow.date.slice(PREFIX.length),
    token: e.token || "",
    env: e.env || "prod",
    attrs: e.attrs || {},
    state: e.state || {},
    track: e.track || null,
    paused: !!e.paused,
    last_push_at: e.last_push_at || null,
    last_feed_at: e.last_feed_at || null,
    last_progress_at: e.last_progress_at || null,
    expires_at: e.expires_at || null,
    updated_at: cacheRow.updated_at || null,
  };
}

/* 컬럼형 행 → sf_cache 행 */
function toCache(row, now = Date.now()) {
  const e = { tripId: row.trip_id };
  for (const k of ROW_KEYS) if (k !== "trip_id" && row[k] !== undefined) e[k] = row[k];
  return { date: PREFIX + row.trip_id, events: e, updated_at: new Date(now).toISOString() };
}

/* ── 주행 행 저장소 API ───────────────────────────────────────────────────── */

/** 접두사가 붙은 주행 행 전부(잠금 행 제외). 필터는 JS 에서 한다. */
async function listTrips() {
  const t = dedicatedTable();
  if (t) return await sbSelect(t, "select=*");
  /* 소프트 삭제된 행은 toTrip 이 null 로 걸러 낸다. 노선 이력 행(ssl:la:hist:*)은 크니 받아 오지 않는다(toTrip 도 거른다) */
  const rows = await sbSelect(CACHE_TABLE, `date=like.${encodeURIComponent(PREFIX + "*")}&date=not.like.${encodeURIComponent(HIST_PREFIX + "*")}&date=neq.${encodeURIComponent(PARKED_KEY)}&select=date,events,updated_at`);
  return (Array.isArray(rows) ? rows : []).map(toTrip).filter(Boolean);
}

/** 지금 푸시 대상인 행(paused=false, 아직 만료 전) — updated_at 오름차순 */
function activeTrips(rows, now = Date.now()) {
  return (rows || [])
    .filter((r) => r && !r.deleted && !r.paused && r.token && (!r.expires_at || Date.parse(r.expires_at) > now))
    .sort((a, b) => Date.parse(a.updated_at || 0) - Date.parse(b.updated_at || 0));
}

async function getTrip(tripId) {
  const t = dedicatedTable();
  if (t) {
    const rows = await sbSelect(t, `trip_id=eq.${encodeURIComponent(tripId)}&select=*`);
    return (Array.isArray(rows) && rows[0]) || null;
  }
  const rows = await sbSelect(CACHE_TABLE, `date=eq.${encodeURIComponent(PREFIX + tripId)}&select=date,events,updated_at`);
  return toTrip(Array.isArray(rows) ? rows[0] : null);
}

/** 행 전체 저장(upsert). rows 는 컬럼형 행 배열 또는 단건. */
async function saveTrips(rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return [];
  const t = dedicatedTable();
  if (t) return await sbUpsert(t, list.map((r) => Object.assign({}, r, { updated_at: new Date(now).toISOString() })), "trip_id");
  return await sbUpsert(CACHE_TABLE, list.map((r) => toCache(r, now)), "date");
}

/** 있는 행에 일부 필드만 덮어쓴다. 행이 없으면 null. (jsonb 한 덩어리라 읽고-합치고-쓴다) */
async function patchTrip(tripId, patch, now = Date.now()) {
  const cur = await getTrip(tripId);
  if (!cur) return null;
  const merged = Object.assign({}, cur, patch, { trip_id: tripId });
  await saveTrips([merged], now);
  return merged;
}

/* 지우고 실제로 지워진 행을 돌려받는다. anon 키는 RLS 때문에 DELETE 가 200 + [] 로 조용히 무시된다. */
async function sbDeleteReturning(table, query) {
  const r = await sbFetch(`${table}?${query}`, {
    method: "DELETE",
    headers: Object.assign(sbHeaders(), { Prefer: "return=representation" }),
  });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

/* 소프트 삭제 표시 — sf_cache 는 anon 이 upsert 는 되지만 delete 는 안 된다 */
const tombstone = (now = Date.now()) => ({ deleted: true, deleted_at: new Date(now).toISOString() });

/** 행 삭제. sf_cache 모드: 먼저 진짜 DELETE(서비스 키면 성공) → 지워지지 않은 행은
 *  events = {deleted:true, deleted_at} 로 덮어써 소프트 삭제한다(목록·조회에서 없는 것으로 본다). */
async function deleteTrips(tripIds, now = Date.now()) {
  const ids = [...new Set((tripIds || []).filter(Boolean))];
  if (!ids.length) return;
  const t = dedicatedTable();
  if (t) return await sbDelete(t, `trip_id=in.(${ids.map((i) => `"${i}"`).join(",")})`);
  let gone = new Set();
  try {
    const rows = await sbDeleteReturning(CACHE_TABLE, `date=in.(${ids.map((i) => `"${PREFIX}${i}"`).join(",")})`);
    gone = new Set(rows.map((r) => r && r.date).filter(Boolean));
  } catch (e) { /* 권한 오류 등 → 전부 소프트 삭제 */ }
  const left = ids.filter((i) => !gone.has(PREFIX + i));
  if (!left.length) return;
  const at = new Date(now).toISOString();
  await sbUpsert(CACHE_TABLE, left.map((i) => ({ date: PREFIX + i, events: tombstone(now), updated_at: at })), "date");
}

/* ── 노선 관측 이력(sf_cache 'ssl:la:hist:<노선>') ─────────────────────────── */
/* 없거나 모양이 다르면 null. 실패는 throw(호출자가 삼킨다). */
async function getHist(line) {
  const key = HIST_PREFIX + line;
  const rows = await sbSelect(CACHE_TABLE, `date=eq.${encodeURIComponent(key)}&select=date,events,updated_at`);
  const row = Array.isArray(rows) ? rows.find((r) => r && r.date === key) : null;
  if (!row || !row.events || row.events.deleted === true || !row.events.trains) return null;
  return row.events;
}
async function saveHist(line, hist, now = Date.now()) {
  await sbFetch(`${CACHE_TABLE}?on_conflict=date`, {
    method: "POST",
    headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates,return=minimal" }),   /* 큰 행 — 돌려받지 않는다 */
    body: JSON.stringify([{ date: HIST_PREFIX + line, events: hist, updated_at: new Date(now).toISOString() }]),
  });
}

/* ── 운행 대기 등록부(sf_cache 'ssl:la:parked', 한 행에 맵) ─────────────────── */
/* 없거나 모양이 다르면 null. 실패는 throw(호출자가 삼킨다). */
async function getParked() {
  const rows = await sbSelect(CACHE_TABLE, `date=eq.${encodeURIComponent(PARKED_KEY)}&select=date,events,updated_at`);
  const row = Array.isArray(rows) ? rows.find((r) => r && r.date === PARKED_KEY) : null;
  if (!row || !row.events || row.events.deleted === true || !row.events.trains) return null;
  return row.events;
}
async function saveParked(reg, now = Date.now()) {
  await sbFetch(`${CACHE_TABLE}?on_conflict=date`, {
    method: "POST",
    headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ date: PARKED_KEY, events: reg, updated_at: new Date(now).toISOString() }]),
  });
}

/* ── 체인 잠금 ───────────────────────────────────────────────────────────── */
/* 자기 호출(self-chaining) 틱이 여러 개 동시에 돌지 않도록 하는 짧은 임대. */

async function getLock() {
  const rows = await sbSelect(CACHE_TABLE, `date=eq.${encodeURIComponent(LOCK_KEY)}&select=date,events,updated_at`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.events || row.events.deleted === true) return null;
  const until = Number(row.events.until) || 0;
  return { id: String(row.events.id || ""), until };
}

async function setLock(id, untilMs, now = Date.now()) {
  await sbUpsert(CACHE_TABLE, { date: LOCK_KEY, events: { id, until: untilMs }, updated_at: new Date(now).toISOString() }, "date");
}

/* 잠금 해제 = 진짜 DELETE 를 시도하고, 지워지지 않았으면(anon RLS) {id:null, until:0} 으로 덮어쓴다 —
   lockFree/lockOwned 는 until 이 0 이면 비어 있는 것으로 본다. */
async function clearLock(now = Date.now()) {
  let rows = [];
  try { rows = await sbDeleteReturning(CACHE_TABLE, `date=eq.${encodeURIComponent(LOCK_KEY)}`); } catch (e) { rows = []; }
  if (rows.length) return;
  await sbUpsert(CACHE_TABLE, { date: LOCK_KEY, events: { id: null, until: 0 }, updated_at: new Date(now).toISOString() }, "date");
}

/** 이 체인(id)이 계속 돌아도 되는가 — 잠금이 없거나·만료됐거나·내 것이면 true */
const lockOwned = (lock, id, now = Date.now()) => !lock || !lock.until || lock.until <= now || lock.id === id;

/** 새 체인을 띄워야 하는가 — 살아 있는 잠금이 없으면 true */
const lockFree = (lock, now = Date.now()) => !lock || !lock.until || lock.until <= now;

module.exports = {
  PREFIX, LOCK_KEY, HIST_PREFIX, PARKED_KEY, CACHE_TABLE, ROW_KEYS, getHist, saveHist, getParked, saveParked,
  apiKey, sbHeaders, sbSelect, sbUpsert, sbPatch, sbDelete,
  toTrip, toCache, tombstone, listTrips, activeTrips, getTrip, saveTrips, patchTrip, deleteTrips,
  getLock, setLock, clearLock, lockOwned, lockFree, dedicatedTable,
};
