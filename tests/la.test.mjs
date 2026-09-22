/* 주행 추적 상태 머신 테스트 — 가짜 피드로 돌린다(네트워크·DB·APNs 없음).
   실행:  node --test tests/la.test.mjs       (또는 node tests/la.test.mjs) */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TS = require("../lib/trip-state.js");
const LA = require("../lib/la-core.js");
const { applyTrack, normStation, clockAfter } = TS;
const { computeRow } = LA;

/* 5호선 한 구간: 광화문 → 천호 (실제 역 순서 일부) */
const L5 = ["광화문", "을지로4가", "동대문역사문화공원", "청구", "신금호", "행당", "왕십리", "마장", "답십리", "장한평", "군자", "아차산", "광나루", "천호"];
const train = (no, stn, sttus, term) => ({ trainNo: String(no), statnNm: stn, trainSttus: String(sttus), statnTnm: term || "하남검단산", updnLine: "1" });
const feedOf = (map) => (line) => map[line] || [];

function baseTrack(over = {}) {
  return Object.assign({
    no: "5001", line: "5호선", legIdx: 0, stations: L5, legTo: "천호",
    isLast: true, laterMin: 0, dest: "하남검단산", stops: null, approach: [],
    legs: [{ line: "5호선", to: "천호", min: 26 }],
  }, over);
}
const prevState = (over = {}) => Object.assign({
  remainMin: 26, arriveAt: "오후 1:00", line: "5호선", colorHex: "#996CAC",
  nextStation: "을지로4가", legTo: "천호", isLast: true, done: false,
  waiting: false, waitMin: 0, toLine: "5호선", toColorHex: "#996CAC", alight: false, endEpoch: 0,
}, over);

/* ContentState 키/타입이 TripAttributes.ContentState 와 정확히 같은지 */
const CS_SHAPE = {
  remainMin: "number", arriveAt: "string", line: "string", colorHex: "string", nextStation: "string",
  legTo: "string", isLast: "boolean", done: "boolean", waiting: "boolean", waitMin: "number",
  toLine: "string", toColorHex: "string", alight: "boolean", endEpoch: "number",
};
function assertShape(s, label) {
  for (const [k, t] of Object.entries(CS_SHAPE)) {
    assert.equal(typeof s[k], t, `${label}: ${k} should be ${t}, got ${typeof s[k]} (${s[k]})`);
  }
  assert.ok(Number.isInteger(s.remainMin), `${label}: remainMin must be Int`);
  assert.ok(Number.isInteger(s.waitMin), `${label}: waitMin must be Int`);
  for (const k of Object.keys(s)) assert.ok(k in CS_SHAPE, `${label}: unexpected key ${k}`);
}

test("normStation — 피드 표기를 경로 역명에 맞춘다", () => {
  assert.equal(normStation("천호역"), "천호");
  assert.equal(normStation("천호(풍납토성)"), "천호");
  assert.equal(normStation(" 왕십리 "), "왕십리");
  assert.equal(normStation("역"), "역");            // 한 글자는 그대로(Swift 와 동일)
});

test("clockAfter — 'a h:mm' ko_KR / Asia/Seoul", () => {
  const s = clockAfter(0, Date.UTC(2026, 0, 5, 4, 36));   // 13:36 KST
  assert.equal(s, "오후 1:36");
});

test("정상 진행 — 남은 시간·다음 역", () => {
  const now = Date.now();
  const r = applyTrack(baseTrack(), train("5001", "왕십리역", "1"), prevState(), now);
  // idx=6, last=13 → (13-6+0)*2 = 14분, 다음 역 마장
  assert.equal(r.state.remainMin, 14);
  assert.equal(r.state.nextStation, "마장");
  assert.equal(r.state.alight, false);
  assert.equal(r.state.done, false);
  assert.equal(r.state.waiting, false);
  assert.equal(r.state.endEpoch, now + 14 * 60000);
  assertShape(r.state, "progress");
});

test("정상 진행 — 진입 중(sttus 0)이면 다음 역을 현재 역으로 본다", () => {
  const r = applyTrack(baseTrack(), train("5001", "왕십리", "0"), prevState(), Date.now());
  // (13-6+0.5)*2 = 15분, 아직 왕십리에 진입 중이므로 다음 역 = 왕십리
  assert.equal(r.state.remainMin, 15);
  assert.equal(r.state.nextStation, "왕십리");
});

test("급행 통과역 건너뛰기 — 다음 '정차'역과 1.4분/역", () => {
  const stops = ["광화문", "동대문역사문화공원", "왕십리", "군자", "천호"];
  const r = applyTrack(baseTrack({ stops }), train("5001", "왕십리", "2"), prevState(), Date.now());
  // idx=6, sttus 2 → nextIdx=7(마장) → 정차역 아님 → 군자(10)로 건너뜀
  assert.equal(r.state.nextStation, "군자");
  // (13-6-0.4)*1.4 = 9.24 → 9분
  assert.equal(r.state.remainMin, 9);
});

test("출발역 접근 중 — 대기 상태", () => {
  const tk = baseTrack({ approach: ["서대문", "충정로"] });   // 현재 역 → 출발역(광화문) 직전, 구간 밖
  const r = applyTrack(tk, train("5001", "서대문", "1"), prevState(), Date.now());
  assert.equal(r.phase, "approach");
  assert.equal(r.state.waiting, true);
  assert.equal(r.state.waitMin, 5);   // 2정거장 * 2분 + 0.5 = 4.5 → 5
  // stopsToOrigin=2 → wait 4.5분, leg 13*2=26분 → 30.5 → 31
  assert.equal(r.state.remainMin, 31);
  assert.equal(r.state.nextStation, "광화문");
  assertShape(r.state, "approach");
});

test("하차 감지 — 다음 역이 구간 종료역", () => {
  const r = applyTrack(baseTrack(), train("5001", "광나루", "1"), prevState(), Date.now());
  assert.equal(r.state.alight, true);
  assert.equal(r.state.nextStation, "천호");
  assert.equal(r.state.remainMin, 2);
});

test("최종 도착 — done", () => {
  const r = applyTrack(baseTrack(), train("5001", "천호역", "1"), prevState(), Date.now());
  assert.equal(r.atEnd, true);
  assert.equal(r.state.done, true);
  assert.equal(r.state.remainMin, 0);
  assert.equal(r.state.nextStation, "천호");
  assert.equal(r.legEnded, false);   // 마지막 구간이므로 환승 대기로 가지 않는다
});

test("최종역이라도 진입 중(0)이면 아직 도착이 아니다", () => {
  const r = applyTrack(baseTrack(), train("5001", "천호", "0"), prevState(), Date.now());
  assert.equal(r.atEnd, false);
  assert.equal(r.state.done, false);
  assert.equal(r.state.alight, true);   // 다음 정차 = 천호 = 구간 종료역
});

test("피드에 열차가 없으면 상태를 바꾸지 않는다", () => {
  assert.equal(applyTrack(baseTrack(), null, prevState()), null);
  const r = computeRow({ trip_id: "t", token: "tok", state: prevState(), track: baseTrack(), last_push_at: new Date().toISOString() },
    feedOf({ "5호선": [train("9999", "왕십리", "1")] }), Date.now());
  assert.equal(r.note, "train-not-in-feed");
  assert.equal(r.changed, false);
  assert.equal(r.push, null);   // 방금 보냈으니 하트비트도 없음
});

/* ── computeRow(틱 1행) ───────────────────────────────────────────────────── */

test("computeRow — 열차 미선택 행은 아무것도 보내지 않는다", () => {
  const r = computeRow({ trip_id: "t", token: "tok", state: prevState(), track: null }, feedOf({}), Date.now());
  assert.equal(r.note, "no-track");
  assert.equal(r.push, null);
  assert.deepEqual(r.state, prevState());
});

test("computeRow — 내용이 그대로여도 60초가 지나면 하트비트 푸시", () => {
  const now = Date.now();
  const row = { trip_id: "t", token: "tok", state: prevState(), track: baseTrack(), last_push_at: new Date(now - 90000).toISOString() };
  const r = computeRow(row, feedOf({ "5호선": [train("9999", "왕십리", "1")] }), now);
  assert.ok(r.push, "하트비트가 나가야 한다");
  assert.equal(r.push.event, "update");
  assert.equal(r.push.priority, 5);
});

test("computeRow — 하차 전환이면 우선순위 10 + 알림", () => {
  const now = Date.now();
  const row = { trip_id: "t", token: "tok", attrs: { to: "천호" }, state: prevState({ alight: false }), track: baseTrack(), last_push_at: new Date(now).toISOString() };
  const r = computeRow(row, feedOf({ "5호선": [train("5001", "광나루", "1")] }), now);
  assert.equal(r.push.priority, 10);
  assert.deepEqual(r.push.alert, { title: "곧 내리세요", body: "다음 역 천호에서 내리세요" });
});

test("computeRow — 최종 도착이면 end 푸시 + 행 삭제 + 도착 알림", () => {
  const now = Date.now();
  const row = { trip_id: "t", token: "tok", attrs: { from: "광화문", to: "천호" }, state: prevState(), track: baseTrack(), last_push_at: new Date(now).toISOString() };
  const r = computeRow(row, feedOf({ "5호선": [train("5001", "천호", "1")] }), now);
  assert.equal(r.push.event, "end");
  assert.equal(r.remove, true);
  assert.equal(r.push.priority, 10);
  assert.deepEqual(r.push.alert, { title: "목적지 도착", body: "천호에 도착했습니다" });
  assert.ok(r.push.dismissalSec >= Math.floor(now / 1000) + 8);
  assert.equal(r.state.done, true);
});

/* 환승: 5호선 왕십리에서 내려 2호선으로 갈아타 건대입구까지 */
const L2 = ["왕십리", "한양대", "뚝섬", "성수", "건대입구"];
function transferRow(over = {}) {
  const legs = [
    { line: "5호선", to: "왕십리", min: 12 },
    { line: "2호선", to: "건대입구", min: 8, stations: L2 },   // stations 가 있어야 자동 승차 판단이 가능
  ];
  return Object.assign({
    trip_id: "x", token: "tok", attrs: { from: "광화문", to: "건대입구", transfers: 1 },
    state: prevState({ legTo: "왕십리", isLast: false, toLine: "2호선", toColorHex: "#00A84D" }),
    track: baseTrack({ stations: L5.slice(0, 7), legTo: "왕십리", isLast: false, laterMin: 5 + 8, legs }),
  }, over);
}

test("환승 — 구간 종료 시 대기 상태로 전환(다음 구간 노선/색으로 바뀐다)", () => {
  const now = Date.now();
  const r = computeRow(transferRow({ last_push_at: new Date(now).toISOString() }), feedOf({ "5호선": [train("5001", "왕십리", "1")] }), now);
  assert.equal(r.note, "leg-end");
  assert.equal(r.state.waiting, true);
  assert.equal(r.state.done, false);
  assert.equal(r.state.line, "2호선");
  assert.equal(r.state.colorHex, "#00A84D");
  assert.equal(r.state.nextStation, "왕십리");     // 여기서 갈아탄다
  assert.equal(r.state.legTo, "건대입구");
  assert.equal(r.state.isLast, true);
  assert.equal(r.state.waitMin, 3);
  assert.equal(r.state.remainMin, 13);
  assert.ok(r.track.legEndedAt, "다음 틱을 위해 구간 종료 시각이 남아야 한다");
  assert.equal(r.push.priority, 10);               // waiting 전환
  assertShape(r.state, "transfer-wait");
});

test("환승 — 3분 전에는 열차를 잡지 않는다(대기 유지)", () => {
  const now = Date.now();
  const row = transferRow();
  row.track = Object.assign({}, row.track, { legEndedAt: now - 60000 });
  row.state = Object.assign({}, row.state, { waiting: true, waitMin: 3, line: "2호선" });
  const r = computeRow(row, feedOf({ "2호선": [{ trainNo: "2222", statnNm: "왕십리", trainSttus: "1", statnTnm: "성수", updnLine: "0" }] }), now);
  assert.equal(r.note, "waiting");
  assert.equal(r.state.waiting, true);
  assert.equal(r.state.waitMin, 2);
});

test("환승 — 3분 뒤 방향이 맞는 열차에 자동 승차", () => {
  const now = Date.now();
  const row = transferRow();
  row.track = Object.assign({}, row.track, { legEndedAt: now - 4 * 60000 });
  row.state = Object.assign({}, row.state, { waiting: true, waitMin: 1, line: "2호선", legTo: "건대입구", isLast: true });
  const feed = feedOf({ "2호선": [
    { trainNo: "2111", statnNm: "왕십리", trainSttus: "1", statnTnm: "시청", updnLine: "0" },      // 목록 밖 종착 → 판단 불가
    { trainNo: "2222", statnNm: "왕십리역", trainSttus: "0", statnTnm: "성수", updnLine: "0" },    // 건대 방향
  ] });
  const r = computeRow(row, feed, now);
  assert.equal(r.note, "auto-board");
  assert.equal(r.track.no, "2222");
  assert.equal(r.track.legIdx, 1);
  assert.equal(r.track.line, "2호선");
  assert.deepEqual(r.track.stations, L2);
  assert.equal(r.track.isLast, true);
  assert.equal(r.state.waiting, false);
  assert.equal(r.state.nextStation, "왕십리");      // 진입 중(0) → 다음 정차는 현재 역
  assert.equal(r.state.remainMin, 9);               // (4-0+0.5)*2
  assertShape(r.state, "auto-board");
});

test("환승 — 반대 방향뿐이면 추측하지 않고 대기 유지", () => {
  const now = Date.now();
  const row = transferRow();
  row.track = Object.assign({}, row.track, { legEndedAt: now - 5 * 60000 });
  row.state = Object.assign({}, row.state, { waiting: true, line: "2호선" });
  const feed = feedOf({ "2호선": [{ trainNo: "2333", statnNm: "왕십리", trainSttus: "1", statnTnm: "시청", updnLine: "1" }] });
  const r = computeRow(row, feed, now);
  assert.equal(r.note, "waiting");
  assert.equal(r.state.waiting, true);
});

test("환승 — 다음 구간 역 목록이 없으면 자동 승차하지 않는다", () => {
  const now = Date.now();
  const legs = [{ line: "5호선", to: "왕십리", min: 12 }, { line: "2호선", to: "건대입구", min: 8 }];   // stations 없음
  const row = transferRow();
  row.track = Object.assign({}, row.track, { legs, legEndedAt: now - 10 * 60000 });
  row.state = Object.assign({}, row.state, { waiting: true, line: "2호선" });
  const r = computeRow(row, feedOf({ "2호선": [{ trainNo: "2222", statnNm: "왕십리", trainSttus: "1", statnTnm: "성수" }] }), now);
  assert.equal(r.note, "waiting");
  assert.equal(r.state.waiting, true);
});


/* ── 저장소 매핑(sf_cache) ────────────────────────────────────────────────── */

const store = require("../lib/supabase.js");

test("sf_cache — 행 왕복(toCache → toTrip)", () => {
  const now = Date.now();
  const row = {
    trip_id: "abc", token: "tok", env: "sandbox", attrs: { from: "광화문", to: "천호", transfers: 0 },
    state: prevState(), track: baseTrack(), paused: false,
    last_push_at: new Date(now).toISOString(), last_feed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
  };
  const cache = store.toCache(row, now);
  assert.equal(cache.date, "ssl:la:abc");
  assert.equal(cache.events.tripId, "abc");
  assert.ok(cache.updated_at);
  const back = store.toTrip(cache);
  for (const k of store.ROW_KEYS) assert.deepEqual(back[k], row[k], `round-trip ${k}`);
});

test("sf_cache — 잠금 행과 남의 행은 주행으로 읽지 않는다", () => {
  assert.equal(store.toTrip({ date: "ssl:la:lock", events: { id: "x", until: 1 } }), null);
  assert.equal(store.toTrip({ date: "2026-09-22", events: [] }), null);   // 다른 앱의 날짜 캐시
  assert.equal(store.toTrip({ date: "af-lineup-123", events: {} }), null);
  assert.equal(store.toTrip(null), null);
});

test("activeTrips — paused/만료/토큰 없음을 거르고 오래된 순으로 준다", () => {
  const now = Date.now();
  const mk = (id, over) => Object.assign({ trip_id: id, token: "t", paused: false, expires_at: new Date(now + 60000).toISOString(), updated_at: new Date(now).toISOString() }, over);
  const rows = [
    mk("paused", { paused: true }),
    mk("expired", { expires_at: new Date(now - 1000).toISOString() }),
    mk("notoken", { token: "" }),
    mk("new", { updated_at: new Date(now).toISOString() }),
    mk("old", { updated_at: new Date(now - 60000).toISOString() }),
  ];
  assert.deepEqual(store.activeTrips(rows, now).map((r) => r.trip_id), ["old", "new"]);
});

/* ── 체인 잠금 판정 ───────────────────────────────────────────────────────── */

test("체인 잠금 — 없음/만료/내 것/남의 것", () => {
  const now = Date.now();
  assert.equal(store.lockOwned(null, "me", now), true);                              // 없음
  assert.equal(store.lockOwned({ id: "other", until: now - 1 }, "me", now), true);   // 만료
  assert.equal(store.lockOwned({ id: "me", until: now + 60000 }, "me", now), true);  // 내 것
  assert.equal(store.lockOwned({ id: "other", until: now + 60000 }, "me", now), false); // 남의 것 — 물러난다

  assert.equal(store.lockFree(null, now), true);
  assert.equal(store.lockFree({ id: "other", until: now - 1 }, now), true);
  assert.equal(store.lockFree({ id: "other", until: now + 60000 }, now), false);
});

/* ── 핸들러(api/la.js) — Supabase/피드/APNs 를 가짜 fetch 로 대체 ──────────── */

const handler = require("../api/la.js");

function fakeRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const call = async (req) => { const res = fakeRes(); await handler(Object.assign({ method: "GET", query: {}, headers: {} }, req), res); return res; };

const jsonRes = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

/* Supabase(sf_cache) + 위치 피드 + 자기 호출을 흉내내는 fetch.
   opts: { rows: [sf_cache 행], lock: {id,until}|null, feed: [열차] } */
function installFetch(opts) {
  const seen = { urls: [], writes: [], chain: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.urls.push(`${init.method || "GET"} ${u}`);
    if (u.includes("/api/la")) { seen.chain.push(u); return jsonRes({ ok: true }); }
    if (u.includes("swopenapi")) return jsonRes({ realtimePositionList: opts.feed || [] });
    if (u.includes("/rest/v1/sf_cache")) {
      if ((init.method || "GET") === "GET") {
        if (u.includes("lock")) return jsonRes(opts.lock ? [{ date: "ssl:la:lock", events: opts.lock }] : []);
        return jsonRes(opts.rows || []);
      }
      seen.writes.push({ method: init.method, url: u, body: init.body ? JSON.parse(init.body) : null });
      return jsonRes(init.body ? JSON.parse(init.body) : []);
    }
    return jsonRes({});
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

function envUp() {
  process.env.LA_CRON_SECRET = "s3cr3t";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_ANON_KEY = "fake-anon";
  process.env.SUBWAY_API_KEY = "fake";
  process.env.LA_SELF_URL = "https://self.test";
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.LA_TABLE;
}

test("handler — tick 은 x-cron-secret 없이 401", async () => {
  envUp();
  const res = await call({ query: { op: "tick" } });
  assert.equal(res.code, 401);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("handler — LA_CRON_SECRET 이 없으면 APNs 키 식별자에서 유도한다", async () => {
  envUp();
  delete process.env.LA_CRON_SECRET;
  process.env.APNS_KEY_ID = "ABCDE12345";
  process.env.APNS_TEAM_ID = "P7ZN2XXS75";
  const { createHash } = await import("node:crypto");
  const want = createHash("sha256").update("ABCDE12345|P7ZN2XXS75").digest("hex");
  assert.equal(handler.cronSecret(), want);
  const f = installFetch({ rows: [] });
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": want } });
    assert.equal(res.code, 200);
  } finally { f.restore(); process.env.LA_CRON_SECRET = "s3cr3t"; }
});

test("handler — 알 수 없는 op / GET register", async () => {
  envUp();
  assert.equal((await call({ method: "POST", query: { op: "nope" } })).code, 400);
  assert.equal((await call({ method: "GET", query: { op: "register" } })).code, 405);
  assert.equal((await call({ method: "POST", query: { op: "register" }, body: {} })).code, 400);   // tripId 없음
});

test("handler — dry 틱이 계산 결과를 돌려준다(푸시·쓰기 없음)", async () => {
  envUp();
  const now = Date.now();
  const rows = [store.toCache({
    trip_id: "dry-1", token: "tok", env: "prod", attrs: { from: "광화문", to: "천호" },
    state: prevState(), track: baseTrack(), paused: false,
    last_push_at: new Date(now - 5000).toISOString(), expires_at: new Date(now + 3600000).toISOString(),
  }, now - 1000)];
  const f = installFetch({ rows, feed: [train("5001", "광나루", "1")] });
  try {
    const res = await call({ query: { op: "tick", dry: "1" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 200);
    assert.equal(res.body.dry, true);
    assert.equal(res.body.rows, 1);
    assert.deepEqual(res.body.lines, ["5호선"]);
    const r0 = res.body.results[0];
    assert.equal(r0.tripId, "dry-1");
    assert.equal(r0.state.alight, true);
    assert.equal(r0.push.priority, 10);
    assert.equal(f.seen.writes.length, 0, "dry 모드는 쓰지 않는다");
    assert.equal(f.seen.chain.length, 0, "dry 모드는 체인을 띄우지 않는다");
  } finally { f.restore(); }
});

test("handler — register(paused:false)는 잠금이 없으면 체인을 띄운다", async () => {
  envUp();
  const f = installFetch({ rows: [], lock: null });
  try {
    const res = await call({ method: "POST", query: { op: "register" },
      body: { tripId: "t1", token: "tok", env: "prod", attrs: { to: "천호" }, state: prevState(), track: null, paused: false } });
    assert.equal(res.code, 200);
    assert.equal(res.body.created, true);
    assert.equal(res.body.kicked, true);
    assert.equal(f.seen.chain.length, 1);
    assert.match(f.seen.chain[0], /^https:\/\/self\.test\/api\/la\?op=tick&chain=1&cid=/);
    const saved = f.seen.writes.find((w) => w.body && w.body[0] && w.body[0].date === "ssl:la:t1");
    assert.ok(saved, "sf_cache 에 ssl:la:t1 로 저장");
    assert.equal(saved.body[0].events.token, "tok");
    assert.ok(saved.body[0].events.expires_at, "만료 시각이 있어야 한다");
  } finally { f.restore(); }
});

test("handler — 체인이 살아 있으면 새로 띄우지 않는다", async () => {
  envUp();
  const f = installFetch({ rows: [], lock: { id: "other", until: Date.now() + 60000 } });
  try {
    const res = await call({ method: "POST", query: { op: "register" },
      body: { tripId: "t2", token: "tok", state: prevState(), paused: false } });
    assert.equal(res.body.kicked, false);
    assert.equal(f.seen.chain.length, 0);
  } finally { f.restore(); }
});

test("handler — paused:true 로 등록하면 체인을 띄우지 않는다", async () => {
  envUp();
  const f = installFetch({ rows: [], lock: null });
  try {
    const res = await call({ method: "POST", query: { op: "register" },
      body: { tripId: "t3", token: "tok", state: prevState(), paused: true } });
    assert.equal(res.body.paused, true);
    assert.equal(res.body.kicked, false);
    assert.equal(f.seen.chain.length, 0);
  } finally { f.restore(); }
});

test("handler — 체인 틱: 남의 잠금이 살아 있으면 물러난다", async () => {
  envUp();
  const f = installFetch({ rows: [], lock: { id: "other", until: Date.now() + 60000 } });
  try {
    const res = await call({ query: { op: "tick", chain: "1", cid: "mine" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.skipped, "locked");
    assert.equal(f.seen.chain.length, 0);
  } finally { f.restore(); }
});

test("handler — 체인 틱: 활성 주행이 없으면 잠금을 풀고 멈춘다", async () => {
  envUp();
  const f = installFetch({ rows: [], lock: { id: "mine", until: Date.now() + 60000 } });
  try {
    const res = await call({ query: { op: "tick", chain: "1", cid: "mine" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.rows, 0);
    assert.equal(res.body.chain.next, false);
    assert.ok(f.seen.writes.some((w) => w.method === "DELETE" && w.url.includes("lock")) ||
              f.seen.urls.some((u) => u.startsWith("DELETE") && u.includes("lock")), "잠금 행 삭제");
    assert.equal(f.seen.chain.length, 0);
  } finally { f.restore(); }
});

test("handler — 만료·paused 행만 있으면 틱은 아무것도 하지 않는다", async () => {
  envUp();
  const now = Date.now();
  const rows = [
    store.toCache({ trip_id: "p", token: "tok", paused: true, state: prevState(), track: baseTrack(), expires_at: new Date(now + 60000).toISOString() }, now),
    store.toCache({ trip_id: "e", token: "tok", paused: false, state: prevState(), track: baseTrack(), expires_at: new Date(now - 60000).toISOString() }, now),
  ];
  const f = installFetch({ rows, feed: [train("5001", "왕십리", "1")] });
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.deepEqual({ rows: res.body.rows, pushed: res.body.pushed }, { rows: 0, pushed: 0 });
    assert.equal(f.seen.writes.length, 0);
  } finally { f.restore(); }
});

test("handler — op=diag 는 시크릿을 요구하고 값은 절대 돌려주지 않는다", async () => {
  envUp();
  assert.equal((await call({ query: { op: "diag" } })).code, 401);

  process.env.APNS_KEY = "not-a-real-key";
  process.env.APNS_KEY_ID = "ABCDE12345";
  process.env.APNS_TEAM_ID = "P7ZN2XXS75";
  process.env.APNS_BUNDLE_ID = "com.sehyunko.SeoulSubwayLive";
  const f = installFetch({ rows: [] });
  try {
    const res = await call({ query: { op: "diag" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 200);
    const b = res.body;
    assert.deepEqual(b.apns, {
      keyPresent: true, keyLen: "not-a-real-key".length, keyLooksPem: false,
      keyParses: false, keyNormalizedParses: false,
      keyIdLen: 10, teamIdLen: 10, bundleId: "com.sehyunko.SeoulSubwayLive",
    });
    assert.equal(b.supabase.keySource, "anon-env");
    assert.equal(b.supabase.table, "sf_cache");
    assert.equal(b.supabase.reachable, 200);
    assert.equal(b.feed.subwayKeyPresent, true);
    assert.equal(b.self, "https://self.test");
    assert.equal(b.secretSource, "env");
    const dump = JSON.stringify(b);
    for (const v of ["not-a-real-key", "fake-anon", "s3cr3t", "ABCDE12345", "P7ZN2XXS75"]) {
      assert.ok(!dump.includes(v), `diag 응답에 ${v.slice(0, 4)}… 가 들어가면 안 된다`);
    }
  } finally { f.restore(); delete process.env.APNS_KEY; }
});

test("handler — diag keySource: 서비스 키 / 코드 내장 폴백", async () => {
  envUp();
  const f = installFetch({ rows: [] });
  try {
    process.env.SUPABASE_SERVICE_KEY = "svc";
    let res = await call({ query: { op: "diag" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.supabase.keySource, "service");
    assert.ok(!JSON.stringify(res.body).includes("svc"));

    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    res = await call({ query: { op: "diag" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.supabase.keySource, "anon-builtin");   // lib/supabase.js 의 공개 anon 폴백
    assert.ok(!JSON.stringify(res.body).includes("eyJ"), "키가 응답에 실리면 안 된다");
  } finally { f.restore(); envUp(); }
});

/* ── APNS_KEY 정규화 ──────────────────────────────────────────────────────── */
/* 진짜 키는 절대 쓰지 않는다 — 테스트 안에서 임시 EC P-256 키를 만들어 쓴다. */

const { normalizePem } = require("../lib/apns.js");
const { generateKeyPairSync, createPrivateKey } = await import("node:crypto");
const { privateKey: TEST_PEM } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const TEST_BODY = TEST_PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

test("normalizePem — 헤더 없이 본문만 붙여넣어도 PEM 으로 편다", () => {
  const out = normalizePem(TEST_BODY);
  assert.equal(out, TEST_PEM);
  assert.ok(createPrivateKey(out));
});

test("normalizePem — 따옴표 + 리터럴 \\n 으로 들어와도 편다", () => {
  const pasted = JSON.stringify(TEST_PEM);            // "…\n…\n…" (따옴표째, \n 이스케이프)
  assert.ok(pasted.startsWith('"') && pasted.includes("\\n"));
  const out = normalizePem(pasted);
  assert.equal(out, TEST_PEM);
  assert.ok(createPrivateKey(out));
});

test("normalizePem — 제대로 된 PEM 은 그대로, 한 줄로 뭉친 본문은 64자로 다시 접는다", () => {
  assert.equal(normalizePem(TEST_PEM), TEST_PEM);
  assert.equal(normalizePem(`  ${TEST_PEM}  `), TEST_PEM);
  const oneLine = `-----BEGIN PRIVATE KEY-----${TEST_BODY}-----END PRIVATE KEY-----`;
  assert.equal(normalizePem(oneLine), TEST_PEM);
  assert.ok(createPrivateKey(normalizePem(oneLine)));
  assert.equal(normalizePem(""), "");
  assert.equal(normalizePem("not-a-key"), "not-a-key");   // 알아볼 수 없으면 건드리지 않는다
});

test("handler — diag probe 는 환경별로 한 번씩 쏘고 상태/이유만 돌려준다", async () => {
  envUp();
  const sent = [];
  handler._setPusherFactory(() => ({
    send: async (o) => { sent.push(o); return { status: o.env === "sandbox" ? 403 : 400, reason: o.env === "sandbox" ? "InvalidProviderToken" : "BadDeviceToken", body: '{"reason":"…"}' }; },
    close: () => {},
  }));
  const f = installFetch({ rows: [] });
  try {
    let res = await call({ query: { op: "diag", probe: "1" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.probe, {
      prod: { status: 400, reason: "BadDeviceToken" },
      sandbox: { status: 403, reason: "InvalidProviderToken" },
    });
    assert.deepEqual(sent.map((s) => s.env).sort(), ["prod", "sandbox"]);
    assert.equal(sent[0].token, "0".repeat(64));
    assert.equal(sent[0].event, "update");
    const dump = JSON.stringify(res.body);
    assert.ok(!dump.includes("0000"), "기기 토큰이 응답에 실리면 안 된다");
    assert.ok(!dump.includes("content-state") && !dump.includes("endEpoch"), "페이로드가 응답에 실리면 안 된다");

    /* probeEnv 로 한쪽만 */
    sent.length = 0;
    res = await call({ query: { op: "diag", probe: "1", probeEnv: "prod" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.deepEqual(Object.keys(res.body.probe), ["prod"]);
    assert.equal(sent.length, 1);

    /* 전송이 던져도 {status:0, reason:<message>} 로 살려 준다 */
    handler._setPusherFactory(() => ({ send: async () => { throw new Error("connect ECONNREFUSED"); }, close: () => {} }));
    res = await call({ query: { op: "diag", probe: "1", probeEnv: "sandbox" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.deepEqual(res.body.probe.sandbox, { status: 0, reason: "connect ECONNREFUSED" });

    /* probe 없이 부르면 아무것도 쏘지 않는다 */
    sent.length = 0;
    handler._setPusherFactory(() => ({ send: async () => { sent.push(1); return { status: 200 }; }, close: () => {} }));
    res = await call({ query: { op: "diag" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.probe, undefined);
    assert.equal(sent.length, 0);
  } finally { f.restore(); handler._setPusherFactory(null); }
});
