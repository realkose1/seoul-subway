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

/* 실측 사례: 같은 trainNo가 서로 다른 역·수신시각으로 두 행 찍힘 —
   findTrain/pickNextTrain 은 피드 안 순서와 무관하게 항상 최신 수신분을 골라야 한다
   (옛 행을 고르면 열차가 옛 역에 멈춰 있는 것처럼 보이고 남은 시간이 계속 늘어난다) */
test("findTrain — 같은 trainNo 중복 시 최신 recptnDt를 고른다(순서 무관)", () => {
  const stale = { trainNo: "5049", statnNm: "상일동", statnTnm: "하남검단산", trainSttus: "1", recptnDt: "2026-09-24 11:39:16" };
  const fresh = { trainNo: "5049", statnNm: "강일", statnTnm: "하남검단산", trainSttus: "0", recptnDt: "2026-09-24 11:41:05" };
  // 옛 것이 배열 앞에 있어도 최신(강일)을 골라야 한다
  assert.equal(TS.findTrain([stale, fresh], "5049").statnNm, "강일");
  // 순서를 뒤집어도 결과는 같아야 한다
  assert.equal(TS.findTrain([fresh, stale], "5049").statnNm, "강일");

  const staleB = { trainNo: "5062", statnNm: "상일동", statnTnm: "하남검단산", trainSttus: "1", recptnDt: "2026-09-24 11:41:23" };
  const freshB = { trainNo: "5062", statnNm: "강일", statnTnm: "하남검단산", trainSttus: "2", recptnDt: "2026-09-24 11:40:01" };
  // 이 쌍은 배열상 나중(11:41:23, 상일동)이 실제로는 더 최신이다 — recptnDt 기준으로 골라야 한다
  assert.equal(TS.findTrain([staleB, freshB], "5062").statnNm, "상일동");
  assert.equal(TS.findTrain([freshB, staleB], "5062").statnNm, "상일동");
});

test("findTrain — trainNo 미매칭/빈 목록은 null", () => {
  assert.equal(TS.findTrain([], "5049"), null);
  assert.equal(TS.findTrain([{ trainNo: "1", recptnDt: "2026-09-24 11:00:00" }], "9999"), null);
  assert.equal(TS.findTrain(null, "5049"), null);
});

test("dedupByTrainNo — trainNo별 최신 수신분만 남기고, 빈 trainNo는 그대로 둔다", () => {
  const stale = { trainNo: "5049", statnNm: "상일동", recptnDt: "2026-09-24 11:39:16" };
  const fresh = { trainNo: "5049", statnNm: "강일", recptnDt: "2026-09-24 11:41:05" };
  const noNo = { trainNo: "", statnNm: "기타" };
  const out = TS.dedupByTrainNo([stale, fresh, noNo]);
  assert.equal(out.length, 2);
  assert.ok(out.find((t) => t.statnNm === "강일"));
  assert.ok(!out.find((t) => t.statnNm === "상일동"));
  assert.ok(out.find((t) => t.statnNm === "기타"));
});

test("pickNextTrain — 환승역 중복 trainNo가 있어도 최신 위치 기준으로 판단한다", () => {
  const legs = [
    { line: "5호선", to: "천호", min: 10 },
    { line: "8호선", to: "몽촌토성", min: 8 },
  ];
  const track = { legIdx: 0, legTo: "천호", legs };
  const nextLeg8 = { line: "8호선", to: "몽촌토성", stations: ["천호", "강동구청", "몽촌토성"] };
  legs[1] = nextLeg8;
  // 같은 trainNo(8001)가 옛 위치(반대 방향으로 오인될 수 있는 역)와 새 위치(환승역, 올바른 방향)로 중복 등장
  const staleWrong = { trainNo: "8001", statnNm: "몽촌토성", statnTnm: "천호", trainSttus: "1", recptnDt: "2026-09-24 11:00:00" };
  const freshRight = { trainNo: "8001", statnNm: "천호", statnTnm: "몽촌토성", trainSttus: "0", recptnDt: "2026-09-24 11:05:00" };
  const picked = TS.pickNextTrain(track, [staleWrong, freshRight], Date.now());
  assert.ok(picked, "최신 위치 기준으로 승차 판단이 되어야 한다");
  assert.equal(picked.no, "8001");
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
    last_progress_at: new Date(now - 60000).toISOString(),
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
  let chainFail = opts.chainFail || 0;   /* 앞의 N 번은 네트워크 오류로 실패 */
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.urls.push(`${init.method || "GET"} ${u}`);
    if (u.includes("/api/la")) {
      seen.chain.push(u);
      if (chainFail > 0) { chainFail--; throw new TypeError("fetch failed"); }
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    }
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

/* APNs 가짜 — 보낸 것을 모은다 */
function fakePusher(status = 200) {
  const sent = [];
  handler._setPusherFactory(() => ({ send: async (o) => { sent.push(o); return { status, reason: "" }; }, close: () => {} }));
  return { sent, restore: () => handler._setPusherFactory(null) };
}
/* DELETE 로 지운 sf_cache 키들 */
const deleted = (f) => f.seen.urls.filter((u) => u.startsWith("DELETE")).map((u) => decodeURIComponent(u)).join(" ");

/* Vercel 요청 컨텍스트 흉내 — @vercel/functions 가 읽는 것과 같은 심볼 */
function installWaitUntil() {
  const sym = Symbol.for("@vercel/request-context");
  const pending = [];
  globalThis[sym] = { get: () => ({ waitUntil: (p) => { pending.push(p); } }) };
  return { pending, flush: async () => { for (let i = 0; i < pending.length; i++) await pending[i]; }, restore: () => { delete globalThis[sym]; } };
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

test("handler — 만료 행은 end(즉시 dismiss)로 끝내고 지운다, 방금 쓴 paused 행은 건드리지 않는다", async () => {
  envUp();
  const now = Date.now();
  const rows = [
    store.toCache({ trip_id: "p", token: "tok", paused: true, state: prevState(), track: baseTrack(), expires_at: new Date(now + 60000).toISOString() }, now),
    store.toCache({ trip_id: "e", token: "tok", paused: false, state: prevState({ remainMin: 12, arriveAt: "오후 9:32" }), track: baseTrack(), expires_at: new Date(now - 60000).toISOString() }, now),
  ];
  const pz = fakePusher();
  const f = installFetch({ rows, feed: [train("5001", "왕십리", "1")] });
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.rows, 0, "만료 행은 추적 대상이 아니다");
    assert.equal(res.body.swept, 1);
    assert.equal(res.body.ended, 1);
    assert.equal(pz.sent.length, 1);
    const s = pz.sent[0];
    assert.equal(s.event, "end");
    assert.equal(s.token, "tok");
    assert.equal(s.contentState.done, false, "만료는 도착이 아니다 — 마지막 값 유지");
    assert.equal(s.contentState.remainMin, 12);
    assert.equal(s.contentState.arriveAt, "오후 9:32");
    assert.ok(Math.abs(s.dismissalSec - Math.floor(now / 1000)) <= 2, "dismissal-date = now");
    assert.ok(deleted(f).includes("ssl:la:e"));
    assert.ok(!deleted(f).includes("ssl:la:p"), "paused 행(앱 소유)은 30분 전엔 지우지 않는다");
    assert.ok(!f.seen.writes.some((w) => w.method === "POST" && JSON.stringify(w.body).includes("ssl:la:p")));
  } finally { f.restore(); pz.restore(); }
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

/* ── 체인 신뢰성: waitUntil / kick / 정리 ─────────────────────────────────── */

const activeRow = (id, now, over = {}) => store.toCache(Object.assign({
  trip_id: id, token: "tok-" + id, env: "prod", attrs: { from: "광화문", to: "천호" },
  state: prevState(), track: baseTrack(), paused: false,
  last_push_at: new Date(now - 5000).toISOString(), last_feed_at: new Date(now - 5000).toISOString(),
  expires_at: new Date(now + 3600000).toISOString(),
}, over), over.__updated || now);

test("getWaitUntil — 요청 컨텍스트 심볼이 없으면 null, 있으면 그 waitUntil", () => {
  assert.equal(handler.getWaitUntil(), null);
  const w = installWaitUntil();
  try {
    const fn = handler.getWaitUntil();
    assert.equal(typeof fn, "function");
    fn(Promise.resolve(1));
    assert.equal(w.pending.length, 1);
  } finally { w.restore(); }
});

test("handler — 체인 틱(waitUntil 있음): 즉시 202, 일과 다음 틱 넘기기는 waitUntil 안에서", async () => {
  envUp();
  handler._setTiming({ roundMs: 0 });
  const now = Date.now();
  const w = installWaitUntil();
  const pz = fakePusher();
  const f = installFetch({ rows: [activeRow("a", now, { last_push_at: new Date(now - 90000).toISOString() })],
    lock: { id: "mine", until: now + 60000 }, feed: [train("5001", "왕십리", "1")] });
  try {
    const res = await call({ query: { op: "tick", chain: "1", cid: "mine" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 202);
    assert.deepEqual(res.body, { accepted: true, cid: "mine" });
    assert.equal(w.pending.length, 1, "라운드는 waitUntil 에 등록된다");
    await w.flush();
    assert.equal(pz.sent.length, 1, "푸시는 응답 뒤(waitUntil 안)에서 나간다");
    assert.equal(f.seen.chain.length, 1, "다음 틱으로 넘긴다");
    assert.match(f.seen.chain[0], /op=tick&chain=1&cid=mine$/);
    assert.ok(f.seen.writes.some((w2) => w2.body && w2.body.date === "ssl:la:lock" && w2.body.events.id === "mine") ||
              f.seen.writes.some((w2) => Array.isArray(w2.body) && w2.body[0] && w2.body[0].date === "ssl:la:lock"), "잠금 갱신");
  } finally { f.restore(); pz.restore(); w.restore(); handler._setTiming(); }
});

test("handler — register 의 체인 시작도 waitUntil 에 등록된다", async () => {
  envUp();
  const w = installWaitUntil();
  const f = installFetch({ rows: [], lock: null });
  try {
    const res = await call({ method: "POST", query: { op: "register" },
      body: { tripId: "wu1", token: "tok", state: prevState(), paused: false } });
    assert.equal(res.body.kicked, true);
    assert.ok(w.pending.length >= 1);
    await w.flush();
    assert.equal(f.seen.chain.length, 1);
  } finally { f.restore(); w.restore(); }
});

test("handler — 체인 넘기기: 연결 실패는 다시 시도한다(한 번의 실패로 끊기지 않는다)", async () => {
  envUp();
  handler._setTiming({ roundMs: 0 });
  const now = Date.now();
  const pz = fakePusher();
  const f = installFetch({ rows: [activeRow("a", now)], lock: { id: "mine", until: now + 60000 },
    feed: [train("5001", "왕십리", "1")], chainFail: 1 });
  try {
    const res = await call({ query: { op: "tick", chain: "1", cid: "mine" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 200);                      // waitUntil 없음 → 끝까지 돌고 응답
    assert.equal(f.seen.chain.length, 2);
    assert.equal(res.body.chain.next, true);
    assert.equal(res.body.chain.remaining, 1);
  } finally { f.restore(); pz.restore(); handler._setTiming(); }
});

test("handler — op=kick: 잠금 없음 + 활성 행 → 체인 시작(시크릿 불필요)", async () => {
  envUp();
  const now = Date.now();
  const f = installFetch({ rows: [activeRow("a", now)], lock: null });
  try {
    const res = await call({ query: { op: "kick" } });
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { kicked: true });
    assert.equal(f.seen.chain.length, 1);
    assert.ok(f.seen.writes.some((w) => JSON.stringify(w.body || "").includes("ssl:la:lock")), "새 잠금");
  } finally { f.restore(); }
});

test("handler — op=kick: 잠금이 살아 있으면 띄우지 않는다", async () => {
  envUp();
  const now = Date.now();
  const f = installFetch({ rows: [activeRow("a", now)], lock: { id: "other", until: now + 60000 } });
  try {
    const res = await call({ method: "POST", query: { op: "kick" } });
    assert.deepEqual(res.body, { kicked: false, reason: "locked" });
    assert.equal(f.seen.chain.length, 0);
    assert.equal(f.seen.writes.length, 0);
  } finally { f.restore(); }
});

test("handler — op=kick: 할 일(활성·정리 대상 행)이 없으면 띄우지 않는다", async () => {
  envUp();
  const now = Date.now();
  const f = installFetch({ rows: [activeRow("p", now, { paused: true })], lock: null });   // 방금 쓴 paused 행뿐
  try {
    const res = await call({ query: { op: "kick" } });
    assert.deepEqual(res.body, { kicked: false, reason: "no-active-rows" });
    assert.equal(f.seen.chain.length, 0);
    assert.equal(f.seen.writes.length, 0);
  } finally { f.restore(); }
});

test("handler — end 도 체인을 되살린다(다른 활성 주행이 남아 있으면)", async () => {
  envUp();
  const now = Date.now();
  const f = installFetch({ rows: [activeRow("other", now)], lock: null });
  try {
    const res = await call({ method: "POST", query: { op: "end" }, body: { tripId: "gone", local: true } });
    assert.equal(res.body.kicked, true);
    assert.equal(f.seen.chain.length, 1);
  } finally { f.restore(); }
});

test("computeRow+overdueEnd — 도착 예정 +4분 지남·4분간 진척 없음 → 도착 end(60초 뒤 dismiss)", () => {
  const now = Date.now();
  const row = { trip_id: "t", token: "tok", attrs: { to: "천호" },
    state: prevState({ remainMin: 12, endEpoch: now - 10 * 60000 }), track: baseTrack(),
    last_push_at: new Date(now - 90000).toISOString(), last_progress_at: new Date(now - 20 * 60000).toISOString() };
  const x = computeRow(row, feedOf({ "5호선": [] }), now);   // 피드에서 사라짐 → 상태 유지
  const o = LA.overdueEnd(row, x, now);
  assert.ok(o);
  assert.equal(o.note, "overdue");
  assert.equal(o.remove, true);
  assert.equal(o.push.event, "end");
  assert.equal(o.push.dismissalSec, Math.floor(now / 1000) + 60);
  assert.deepEqual(o.push.alert, { title: "목적지 도착", body: "천호에 도착했습니다" });
  assert.equal(o.state.done, true);
  assert.equal(o.state.remainMin, 0);
  assertShape(o.state, "overdue");

  /* 최근 4분 안에 진척이 있었으면 아직 끝내지 않는다 */
  assert.equal(LA.overdueEnd(Object.assign({}, row, { last_progress_at: new Date(now - 60000).toISOString() }), x, now), null);
  /* 열차가 피드에 잡혀 움직이면(endEpoch 가 미래로 다시 계산) 걸리지 않는다 */
  const moving = computeRow(row, feedOf({ "5호선": [train("5001", "왕십리", "1")] }), now);
  assert.equal(LA.overdueEnd(row, moving, now), null);
  /* 예전 행(last_progress_at 없음)은 last_feed_at 으로 판단 */
  const legacy = Object.assign({}, row, { last_progress_at: null, last_feed_at: new Date(now - 30 * 60000).toISOString() });
  assert.ok(LA.overdueEnd(legacy, x, now));
});

test("sweepRow — 30분 넘게 방치된 paused 는 푸시 없이 삭제, 방금 것은 유지", () => {
  const now = Date.now();
  const old = LA.sweepRow({ trip_id: "p", token: "tok", paused: true, state: prevState(), updated_at: new Date(now - 31 * 60000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString() }, now);
  assert.equal(old.remove, true);
  assert.equal(old.push, null);
  assert.equal(old.note, "paused-stale");
  assert.equal(LA.sweepRow({ trip_id: "p", token: "tok", paused: true, updated_at: new Date(now - 60000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString() }, now), null);
  assert.equal(LA.sweepRow({ trip_id: "a", token: "tok", paused: false, expires_at: new Date(now + 60000).toISOString() }, now), null);
});

test("handler — 틱: 지연 행은 도착 end, 오래된 paused 는 푸시 없이 삭제, 정상 행은 계속", async () => {
  envUp();
  const now = Date.now();
  const rows = [
    /* 열차 번호는 앞 테스트들과 겹치지 않게(위치 피드 모듈이 노선별로 4초 캐시한다) */
    activeRow("late", now, { track: baseTrack({ no: "5099" }), state: prevState({ endEpoch: now - 10 * 60000 }), last_progress_at: new Date(now - 15 * 60000).toISOString() }),
    activeRow("ok", now, { track: baseTrack({ no: "5002" }) }),
    activeRow("ps", now, { paused: true, __updated: now - 40 * 60000 }),
  ];
  const pz = fakePusher();
  const f = installFetch({ rows, feed: [train("5002", "왕십리", "1")] });   // late 의 열차(5099)는 피드에 없음
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.rows, 2);
    assert.equal(res.body.swept, 1);
    const late = pz.sent.find((s) => s.token === "tok-late");
    assert.equal(late.event, "end");
    assert.equal(late.contentState.done, true);
    assert.equal(late.alert.title, "목적지 도착");
    assert.ok(!pz.sent.some((s) => s.token === "tok-ps"), "paused 행엔 푸시하지 않는다");
    const d = deleted(f);
    assert.ok(d.includes("ssl:la:late") && d.includes("ssl:la:ps"));
    assert.ok(!d.includes("ssl:la:ok"));
    const saved = f.seen.writes.find((w) => Array.isArray(w.body) && w.body.some((r) => r.date === "ssl:la:ok"));
    const ev = saved.body.find((r) => r.date === "ssl:la:ok").events;
    assert.ok(ev.last_progress_at, "진척 시각을 남긴다");
  } finally { f.restore(); pz.restore(); }
});

test("handler — 체인 틱: 활성 행이 없어도 정리(만료 end)는 하고 나서 잠금을 푼다", async () => {
  envUp();
  const now = Date.now();
  const pz = fakePusher();
  const f = installFetch({ rows: [activeRow("x", now, { expires_at: new Date(now - 1000).toISOString() })], lock: { id: "mine", until: now + 60000 } });
  try {
    const res = await call({ query: { op: "tick", chain: "1", cid: "mine" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.chain.next, false);
    assert.equal(pz.sent.length, 1);
    assert.equal(pz.sent[0].event, "end");
    assert.ok(deleted(f).includes("ssl:la:x"));
    assert.ok(deleted(f).includes("ssl:la:lock"));
    assert.equal(f.seen.chain.length, 0);
  } finally { f.restore(); pz.restore(); }
});

test("handler — op=cleanup: 시크릿 필요, 매달린 것만 끝내고 정상 행은 둔다", async () => {
  envUp();
  assert.equal((await call({ query: { op: "cleanup" } })).code, 401);
  const now = Date.now();
  const rows = [
    activeRow("exp", now, { expires_at: new Date(now - 3600000).toISOString() }),
    activeRow("late", now, { state: prevState({ endEpoch: now - 30 * 60000 }), last_feed_at: new Date(now - 28 * 60000).toISOString() }),
    activeRow("ps", now, { paused: true, __updated: now - 2 * 3600000 }),
    activeRow("fine", now, { state: prevState({ endEpoch: now + 5 * 60000 }) }),
  ];
  const pz = fakePusher();
  const f = installFetch({ rows });
  try {
    const dry = await call({ query: { op: "cleanup", dry: "1" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.deepEqual(dry.body.jobs.map((j) => j.tripId).sort(), ["exp", "late", "ps"]);
    assert.equal(pz.sent.length, 0);
    assert.equal(f.seen.urls.filter((u) => u.startsWith("DELETE")).length, 0);

    const res = await call({ method: "POST", query: { op: "cleanup" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.cleaned, 3);
    assert.equal(res.body.ended, 2);
    assert.deepEqual(res.body.notes, { expired: 1, overdue: 1, "paused-stale": 1 });
    assert.deepEqual(pz.sent.map((s) => s.token).sort(), ["tok-exp", "tok-late"]);
    assert.equal(pz.sent.find((s) => s.token === "tok-exp").contentState.done, false);
    assert.equal(pz.sent.find((s) => s.token === "tok-late").contentState.done, true);
    assert.ok(!deleted(f).includes("ssl:la:fine"));
    assert.equal(f.seen.chain.length, 0, "cleanup 은 체인을 띄우지 않는다");
  } finally { f.restore(); pz.restore(); }
});

/* ── 소프트 삭제(sf_cache 는 anon 키로 DELETE 가 RLS 에 막혀 200 + [] 로 무시된다) ── */

const tomb = (f, id) => f.seen.writes.find((w) => w.method === "POST" && Array.isArray(w.body) &&
  w.body.some((r) => r.date === "ssl:la:" + id && r.events && r.events.deleted === true));

test("store — DELETE 가 [] 를 돌려주면(anon RLS) {deleted:true} 로 덮어쓴다", async () => {
  envUp();
  const f = installFetch({ rows: [] });
  try {
    await store.deleteTrips(["a", "b"]);
    const del = f.seen.urls.find((u) => u.startsWith("DELETE"));
    assert.ok(del && decodeURIComponent(del).includes('"ssl:la:a"'), "먼저 진짜 DELETE 를 시도");
    const w = f.seen.writes.find((x) => x.method === "POST");
    assert.ok(w, "소프트 삭제 upsert");
    assert.deepEqual(w.body.map((r) => r.date).sort(), ["ssl:la:a", "ssl:la:b"]);
    for (const r of w.body) { assert.equal(r.events.deleted, true); assert.ok(r.events.deleted_at); }
    assert.match(w.url, /on_conflict=date/);
  } finally { f.restore(); }
});

test("store — DELETE 가 지운 행을 돌려주면(서비스 키) 그 행은 소프트 삭제하지 않는다", async () => {
  envUp();
  const real = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (init.method === "DELETE") {
      assert.equal(init.headers.Prefer, "return=representation");
      return jsonRes([{ date: "ssl:la:a", events: {} }]);            // a 만 실제로 지워짐
    }
    if (init.method === "POST") writes.push(JSON.parse(init.body));
    return jsonRes([]);
  };
  try {
    await store.deleteTrips(["a", "b"]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].map((r) => r.date), ["ssl:la:b"]);
    writes.length = 0;
    await store.deleteTrips(["a"]);
    assert.equal(writes.length, 0, "다 지워졌으면 upsert 없음");
  } finally { globalThis.fetch = real; }
});

test("store — 소프트 삭제된 행은 목록·조회·활성·정리에서 없는 것으로 본다", async () => {
  envUp();
  const now = Date.now();
  const rows = [
    { date: "ssl:la:gone", events: { deleted: true, deleted_at: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() },
    activeRow("live", now),
  ];
  const f = installFetch({ rows });
  try {
    const all = await store.listTrips();
    assert.deepEqual(all.map((r) => r.trip_id), ["live"]);
    assert.equal(store.toTrip(rows[0]), null);
    assert.equal(store.activeTrips([{ trip_id: "x", token: "t", deleted: true }], now).length, 0);
    assert.equal(LA.sweepRow({ trip_id: "x", deleted: true, token: "t", expires_at: new Date(now - 1).toISOString() }, now), null);
  } finally { f.restore(); }
});

test("store — 잠금 해제: DELETE 가 무시되면 {id:null, until:0} 로 덮어쓰고, 그건 빈 잠금이다", async () => {
  envUp();
  const f = installFetch({ rows: [] });
  try {
    await store.clearLock();
    const w = f.seen.writes.find((x) => x.method === "POST" && JSON.stringify(x.body).includes("ssl:la:lock"));
    assert.ok(w, "잠금 행 upsert");
    const body = Array.isArray(w.body) ? w.body[0] : w.body;
    assert.deepEqual(body.events, { id: null, until: 0 });
  } finally { f.restore(); }
  /* 그렇게 '풀린' 잠금을 읽으면 비어 있다 */
  const f2 = installFetch({ rows: [], lock: { id: null, until: 0 } });
  try {
    const lock = await store.getLock();
    assert.equal(store.lockFree(lock, Date.now()), true);
    assert.equal(store.lockOwned(lock, "anyone", Date.now()), true);
    const res = await call({ query: { op: "kick" } });
    assert.equal(res.body.reason, "no-active-rows", "잠금으로 막히지 않는다");
  } finally { f2.restore(); }
});

test("handler — cleanup 은 anon 환경에서도 행을 소프트 삭제한다(다음 목록에 안 나온다)", async () => {
  envUp();
  const now = Date.now();
  const pz = fakePusher();
  const f = installFetch({ rows: [activeRow("exp", now, { expires_at: new Date(now - 1000).toISOString() })] });
  try {
    const res = await call({ method: "POST", query: { op: "cleanup" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.cleaned, 1);
    assert.ok(tomb(f, "exp"), "{deleted:true} 로 덮어써야 한다");
  } finally { f.restore(); pz.restore(); }
});

/* ── 장시간 정차(출발 대기) ────────────────────────────────────────────────────
   실측(2026-09-24): 5호선 5197(하남검단산행)이 상일동 '도착(1)'을 20초마다 새 수신시각으로 20분 넘게 보냄.
   역당 평균 시간으로 '다음 강일'로 앞당기면 안 되고, 3분이 넘으면 '상일동에서 출발 대기'여야 한다. */
const L5E = ["상일동", "강일", "미사", "하남풍산", "하남시청"];
const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
const trainAt = (no, stn, sttus, recMs, term) => Object.assign(train(no, stn, sttus, term), { recptnDt: kst(recMs) });
const eastTrack = (over = {}) => baseTrack(Object.assign({ no: "5197", stations: L5E, legTo: "하남시청",
  legs: [{ line: "5호선", to: "하남시청", min: 8 }] }, over));

test("출발 대기 — 같은 역 '도착'이 새 기록으로 3분 넘게 이어지면 waiting·waitMin 0·그 역, 다음 역으로 앞당기지 않는다", () => {
  const t0 = Date.UTC(2026, 8, 24, 2, 42, 0);   // 11:42 KST
  let row = { trip_id: "t", token: "tok", attrs: { to: "하남시청" }, state: prevState({ nextStation: "강일", legTo: "하남시청" }),
    track: eastTrack(), last_push_at: new Date(t0).toISOString() };
  const seen = [];
  for (let s = 0; s <= 300; s += 20) {
    const now = t0 + s * 1000 + 15000;           // 피드 지연 15초
    const x = computeRow(row, feedOf({ "5호선": [trainAt("5197", "상일동", "1", t0 + s * 1000, "하남검단산")] }), now);
    assertShape(x.state, `dwell t+${s}`);
    assert.notEqual(x.state.nextStation, "미사", "상일동에 서 있는 동안 강일 너머로 가면 안 된다");
    assert.equal(x.state.remainMin, 8, "남은 시간이 늘거나 줄지 않는다(상일동 기준 계획값)");
    seen.push({ s, waiting: x.state.waiting, next: x.state.nextStation, waitMin: x.state.waitMin, note: x.note });
    row = Object.assign({}, row, { state: x.state, track: x.track });
  }
  const before = seen.filter((v) => v.s < 180), after = seen.filter((v) => v.s >= 180);
  for (const v of before) { assert.equal(v.waiting, false); assert.equal(v.next, "강일"); }
  for (const v of after) {
    assert.equal(v.waiting, true, `t+${v.s}: 3분 넘으면 출발 대기`);
    assert.equal(v.waitMin, 0);
    assert.equal(v.next, "상일동");
    assert.equal(v.note, "dwell");
  }
  assert.equal(row.track.dwell.stn, "상일동");
  assert.equal(row.track.dwell.run, 16);

  /* 드디어 출발(2) → 대기 해제, 다음 역 강일, dwell 초기화 */
  const now = t0 + 320 * 1000 + 15000;
  const x = computeRow(row, feedOf({ "5호선": [trainAt("5197", "상일동", "2", t0 + 320 * 1000, "하남검단산")] }), now);
  assert.equal(x.state.waiting, false);
  assert.equal(x.state.nextStation, "강일");
  assert.equal(x.track.dwell, null);
});

test("출발 대기 — 수신시각이 그대로인 같은 기록·옛 유령 기록은 대기 시간으로 치지 않는다", () => {
  const t0 = Date.UTC(2026, 8, 24, 2, 42, 0);
  let d = TS.nextDwell(null, "상일동", "1", trainAt("5197", "상일동", "1", t0), t0);
  for (let i = 1; i <= 20; i++) d = TS.nextDwell(d, "상일동", "1", trainAt("5197", "상일동", "1", t0), t0 + i * 20000);   // 같은 기록 반복
  assert.equal(d.run, 1);
  assert.equal(TS.dwellConfirmed(d), false, "새 기록 없이 시간만 흐른 것은 확인된 대기가 아니다");
  d = TS.nextDwell(d, "상일동", "1", trainAt("5197", "상일동", "1", t0 + 200000), t0 + 215000);
  assert.equal(TS.dwellConfirmed(d), true);
  const ghost = TS.nextDwell(d, "상일동", "1", trainAt("5197", "상일동", "1", t0 - 60000), t0 + 230000);
  assert.equal(ghost.since, t0);
  assert.equal(ghost.last, t0 + 200000);
  /* 다른 역·다른 상태면 새로 시작/해제 */
  assert.equal(TS.nextDwell(d, "강일", "1", trainAt("5197", "강일", "1", t0 + 260000), t0 + 275000).run, 1);
  assert.equal(TS.nextDwell(d, "상일동", "2", trainAt("5197", "상일동", "2", t0 + 260000), t0 + 275000), null);
});

test("출발 대기 — 출발역 앞 역(접근 구간)에서 서 있으면 'N분 후 출발'을 지어내지 않고 그 역·waitMin 0", () => {
  const t0 = Date.UTC(2026, 8, 24, 2, 42, 0);
  const tk = eastTrack({ stations: ["강일", "미사", "하남풍산", "하남시청"], approach: ["상일동"] });
  let prev = prevState(), track = tk, r;
  for (let s = 0; s <= 200; s += 20) {
    r = applyTrack(track, trainAt("5197", "상일동", "1", t0 + s * 1000), prev, t0 + s * 1000 + 15000);
    track = Object.assign({}, track, { dwell: r.dwell }); prev = r.state;
    if (s < 180) { assert.equal(r.state.nextStation, "강일"); assert.ok(r.state.waitMin >= 1); }
  }
  assert.equal(r.phase, "approach");
  assert.equal(r.dwelling, true);
  assert.equal(r.state.waiting, true);
  assert.equal(r.state.waitMin, 0);
  assert.equal(r.state.nextStation, "상일동");
  assertShape(r.state, "approach-dwell");
});

test("overdueEnd — 확인된 출발 대기 중이면 도착 예정이 지나도 끝내지 않는다(피드에서 사라지면 다시 적용)", () => {
  const now = Date.now();
  const row = { trip_id: "t", token: "tok", attrs: { to: "하남시청" },
    state: prevState({ remainMin: 8, endEpoch: now - 10 * 60000 }), track: eastTrack(),
    last_push_at: new Date(now - 90000).toISOString(), last_progress_at: new Date(now - 20 * 60000).toISOString() };
  const dwell = { stn: "상일동", since: now - 10 * 60000, last: now - 20000, run: 30, seen: now };
  const x = { tripId: "t", token: "tok", env: "prod", state: row.state, track: Object.assign({}, row.track, { dwell }), push: null, remove: false };
  assert.equal(LA.overdueEnd(row, x, now), null, "출발 대기 중인 열차는 '목적지 도착'이 아니다");
  /* 대기 확인이 오래전(피드에서 사라진 뒤 4분+)이면 원래 규칙대로 끝낸다 */
  const gone = Object.assign({}, x, { track: Object.assign({}, x.track, { dwell: Object.assign({}, dwell, { seen: now - 5 * 60000 }) }) });
  assert.ok(LA.overdueEnd(row, gone, now));
});
