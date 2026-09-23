/* Supabase 접근 — 주행 라이브 액티비티 행 저장소.
 *
 * 기본 저장소는 **기존 테이블 public.sf_cache** 다(SQL 실행·pg_cron 설정 없이 바로 쓰려고).
 * 그 앱이 쓰던 키/값 캐시 테이블이고 컬럼은 (date text pk, events jsonb, updated_at timestamptz),
 * RLS 가 anon 에게 select/upsert/delete 를 허용한다.
 *   주행 1건  →  date = 'ssl:la:<tripId>' , events = { tripId, token, env, attrs, state, track,
 *                                                     paused, last_push_at, last_feed_at, last_progress_at, expires_at }
 *   체인 잠금 →  date = 'ssl:la:lock'     , events = { until, id }
 * 접두사를 쓰므로 그 앱의 날짜 행('2026-09-22')·라인업 행('af-lineup-…')과 섞이지 않는다.
 *
 * 전용 테이블(db/live_activity.sql 의 ssl_live_trips)을 만들었다면 환경변수
 * LA_TABLE=ssl_live_trips 를 주면 그쪽(컬럼형)으로 동작한다.
 *
 * 키: SUPABASE_SERVICE_KEY → SUPABASE_ANON_KEY → SUPABASE_ANON_FALLBACK (모두 환경변수. 코드에 키를 넣지 않는다) */

const PREFIX = "ssl:la:";
const LOCK_KEY = `${PREFIX}lock`;
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
  if (cacheRow.date === LOCK_KEY) return null;
  const e = cacheRow.events || {};
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
  const rows = await sbSelect(CACHE_TABLE, `date=like.${encodeURIComponent(PREFIX + "*")}&select=date,events,updated_at`);
  return (Array.isArray(rows) ? rows : []).map(toTrip).filter(Boolean);
}

/** 지금 푸시 대상인 행(paused=false, 아직 만료 전) — updated_at 오름차순 */
function activeTrips(rows, now = Date.now()) {
  return (rows || [])
    .filter((r) => r && !r.paused && r.token && (!r.expires_at || Date.parse(r.expires_at) > now))
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

async function deleteTrips(tripIds) {
  const ids = [...new Set((tripIds || []).filter(Boolean))];
  if (!ids.length) return;
  const t = dedicatedTable();
  if (t) return await sbDelete(t, `trip_id=in.(${ids.map((i) => `"${i}"`).join(",")})`);
  return await sbDelete(CACHE_TABLE, `date=in.(${ids.map((i) => `"${PREFIX}${i}"`).join(",")})`);
}

/* ── 체인 잠금 ───────────────────────────────────────────────────────────── */
/* 자기 호출(self-chaining) 틱이 여러 개 동시에 돌지 않도록 하는 짧은 임대. */

async function getLock() {
  const rows = await sbSelect(CACHE_TABLE, `date=eq.${encodeURIComponent(LOCK_KEY)}&select=date,events,updated_at`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.events) return null;
  const until = Number(row.events.until) || 0;
  return { id: String(row.events.id || ""), until };
}

async function setLock(id, untilMs, now = Date.now()) {
  await sbUpsert(CACHE_TABLE, { date: LOCK_KEY, events: { id, until: untilMs }, updated_at: new Date(now).toISOString() }, "date");
}

async function clearLock() {
  await sbDelete(CACHE_TABLE, `date=eq.${encodeURIComponent(LOCK_KEY)}`);
}

/** 이 체인(id)이 계속 돌아도 되는가 — 잠금이 없거나·만료됐거나·내 것이면 true */
const lockOwned = (lock, id, now = Date.now()) => !lock || !lock.until || lock.until <= now || lock.id === id;

/** 새 체인을 띄워야 하는가 — 살아 있는 잠금이 없으면 true */
const lockFree = (lock, now = Date.now()) => !lock || !lock.until || lock.until <= now;

module.exports = {
  PREFIX, LOCK_KEY, CACHE_TABLE, ROW_KEYS,
  apiKey, sbHeaders, sbSelect, sbUpsert, sbPatch, sbDelete,
  toTrip, toCache, listTrips, activeTrips, getTrip, saveTrips, patchTrip, deleteTrips,
  getLock, setLock, clearLock, lockOwned, lockFree, dedicatedTable,
};
