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

test("환승 — 다음 구간 역 목록이 없으면 자동 승차하지 않는다(7분 전엔 대기, 그 뒤엔 시간 기준으로 진행)", () => {
  const now = Date.now();
  const legs = [{ line: "5호선", to: "왕십리", min: 12 }, { line: "2호선", to: "건대입구", min: 8 }];   // stations 없음
  const feed = feedOf({ "2호선": [{ trainNo: "2222", statnNm: "왕십리", trainSttus: "1", statnTnm: "성수" }] });
  const row = transferRow();
  row.track = Object.assign({}, row.track, { legs, legEndedAt: now - 5 * 60000 });
  row.state = Object.assign({}, row.state, { waiting: true, line: "2호선" });
  let r = computeRow(row, feed, now);
  assert.equal(r.note, "waiting");
  assert.equal(r.state.waiting, true);
  row.track = Object.assign({}, row.track, { legEndedAt: now - 10 * 60000 });
  r = computeRow(row, feed, now);
  assert.equal(r.note, "time-based");                 // 예전: 영원히 'waiting' — 잠금화면이 멈췄다
  assert.equal(r.track.no, "5001");                   // 열차를 지어내지 않는다
  assert.equal(r.state.waiting, false);
  assert.equal(r.state.remainMin, 3);                 // 13 - 10
  assertShape(r.state, "time-based-nostations");
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

const positionFeed = require("../lib/position-feed.js");

function envUp() {
  process.env.LA_CRON_SECRET = "s3cr3t";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_ANON_KEY = "fake-anon";
  process.env.SUBWAY_API_KEY = "fake";
  process.env.LA_SELF_URL = "https://self.test";
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.LA_TABLE;
  positionFeed._resetCache();   /* 노선별 5초 캐시가 테스트 사이로 새지 않도록(특히 op=kick 라운드로빈이 건드리는 노선들) */
  handler._resetParked();       /* histFeedAt(노선당 60초 스로틀)·등록부도 테스트 사이로 새지 않도록 */
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
    /* 라운드로빈 커서(ssl:la:scan)는 등록부·활성 행과 무관하게 전진·저장된다 — 그 외에는 쓰지 않는다 */
    assert.equal(f.seen.writes.filter((w) => !JSON.stringify(w.body || "").includes("ssl:la:scan")).length, 0);
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
    assert.equal(f.seen.writes.filter((w) => !JSON.stringify(w.body || "").includes("ssl:la:scan")).length, 0);
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

/* ── 운행 대기(주박) 판정 · 탄 열차 자동 교체 ─────────────────────────────────
   실측(2026-09-24, 5호선 하남검단산 방면): 5197 이 11:42~12:28+ 상일동 '도착(1)'을 20초마다 새 기록으로 보냄(47분).
   그 사이 5055 가 상일동(12:25:14) → 강일(12:28:09) → 미사로 지나감. 사용자는 상일동에서 하남풍산까지 5055 를 탔다. */
const TH = require("../lib/train-hist.js");
const KST = (h, m, s = 0) => Date.UTC(2026, 8, 24, h - 9, m, s);
const LEG = ["상일동", "강일", "미사", "하남풍산"];
/* 열차별 기록 [{at, stn, st}] → 조회 시각 now 의 피드(각 열차의 now-lag 이전 최신 기록) */
function scenario({ parked = true, with5055 = true, opposite = false, shortDwell = false } = {}) {
  const recs = { "5197": [], "5049": [], "5055": [], "5100": [] };
  const term = { "5197": "하남검단산", "5049": "하남검단산", "5055": "하남검단산", "5100": "방화" };
  const upd = { "5197": "1", "5049": "1", "5055": "1", "5100": "0" };
  if (parked) for (let t = KST(11, 42); t <= KST(12, 40); t += 20000) recs["5197"].push({ at: t, stn: "상일동", st: "1" });
  if (shortDwell) {   /* 정상 40초 정차 뒤 출발 */
    recs["5197"] = [{ at: KST(11, 50), stn: "상일동", st: "1" }, { at: KST(11, 50, 20), stn: "상일동", st: "1" },
      { at: KST(11, 50, 40), stn: "상일동", st: "2" }, { at: KST(11, 52, 10), stn: "강일", st: "0" }, { at: KST(11, 52, 40), stn: "강일", st: "1" },
      { at: KST(11, 53, 10), stn: "강일", st: "2" }, { at: KST(11, 54, 40), stn: "미사", st: "1" }, { at: KST(11, 55, 10), stn: "미사", st: "2" },
      { at: KST(11, 56, 40), stn: "하남풍산", st: "1" }];
  }
  recs["5049"] = [{ at: KST(11, 39, 16), stn: "상일동", st: "1" }, { at: KST(11, 41, 5), stn: "강일", st: "1" },
    { at: KST(11, 43, 0), stn: "미사", st: "1" }, { at: KST(11, 45, 0), stn: "하남풍산", st: "1" }];
  if (with5055) recs["5055"] = [{ at: KST(12, 23, 40), stn: "고덕", st: "2" }, { at: KST(12, 25, 14), stn: "상일동", st: "1" },
    { at: KST(12, 25, 54), stn: "상일동", st: "2" }, { at: KST(12, 28, 9), stn: "강일", st: "2" },
    { at: KST(12, 30, 0), stn: "미사", st: "0" }, { at: KST(12, 30, 30), stn: "미사", st: "1" }, { at: KST(12, 31, 0), stn: "미사", st: "2" },
    { at: KST(12, 32, 30), stn: "하남풍산", st: "0" }, { at: KST(12, 33, 0), stn: "하남풍산", st: "1" }];
  if (opposite) recs["5100"] = [{ at: KST(12, 10), stn: "미사", st: "2" }, { at: KST(12, 12), stn: "강일", st: "1" },
    { at: KST(12, 12, 40), stn: "강일", st: "2" }, { at: KST(12, 14), stn: "상일동", st: "1" }, { at: KST(12, 14, 40), stn: "상일동", st: "2" },
    { at: KST(12, 16), stn: "고덕", st: "1" }];
  return (now, lag = 15000) => {
    const out = [];
    for (const [no, rs] of Object.entries(recs)) {
      const r = rs.filter((x) => x.at <= now - lag).pop();
      if (!r || now - r.at > 3 * 60000) continue;   /* 오래 멈춘 행은 피드에서 빠진다(dropStale 과 같은 효과) */
      out.push(Object.assign(trainAt(no, r.stn, r.st, r.at, term[no]), { updnLine: upd[no] }));
    }
    return out;
  };
}
const legTrack = (over = {}) => baseTrack(Object.assign({ no: "5197", stations: LEG, legTo: "하남풍산",
  legs: [{ line: "5호선", to: "하남풍산", min: 6 }], since: KST(11, 50) }, over));

/* 서버 체인 흉내: 11:42 부터 이력만 쌓고(앱이 지도를 보던 시간), 11:50 부터 50초마다 computeRow */
function runServer(feedAt, { from = KST(11, 50), to = KST(12, 36), track = legTrack() } = {}) {
  const hist = TH.emptyHist();
  for (let t = KST(11, 42); t < from; t += 15000) TH.histObserve(hist, feedAt(t), t);
  let row = { trip_id: "t", token: "tok", attrs: { to: "하남풍산" }, state: prevState({ nextStation: "강일", legTo: "하남풍산" }),
    track, last_push_at: new Date(from).toISOString() };
  const log = [];
  for (let now = from; now <= to; now += 50000) {
    const list = feedAt(now);
    TH.histObserve(hist, list, now); TH.histPrune(hist, now);
    const x = computeRow(row, feedOf({ "5호선": list }), now, () => hist);
    log.push({ now, x });
    if (x.remove) break;
    row = Object.assign({}, row, { state: x.state, track: x.track, last_push_at: x.push ? new Date(now).toISOString() : row.last_push_at });
  }
  return { log, hist, row };
}

test("운행 대기 — 같은 역(종착역 아님) 새 기록 8분 이상이면 parked, 종착역·출발(2)·짧은 정차는 아니다", () => {
  const feedAt = scenario({ with5055: false });
  const h = TH.emptyHist();
  for (let t = KST(11, 42); t <= KST(11, 49); t += 15000) TH.histObserve(h, feedAt(t), t);
  assert.equal(TH.isParked(h, "5197"), false, "7분 — 아직");
  for (let t = KST(11, 49); t <= KST(11, 51); t += 15000) TH.histObserve(h, feedAt(t), t);
  assert.equal(TH.isParked(h, "5197"), true, "8분 넘음");
  assert.equal(TH.parkedInfo(h.trains["5197"]).stn, "상일동");
  /* 종착역에 서 있는 것은 운행 대기로 보지 않는다 */
  const h2 = TH.emptyHist();
  for (let t = KST(11, 0); t <= KST(11, 20); t += 20000) TH.histObserve(h2, [trainAt("5300", "하남검단산", "1", t, "하남검단산")], t + 15000);
  assert.equal(TH.isParked(h2, "5300"), false);
  /* 유령(옛) 기록·같은 기록 반복은 시간을 늘리지 않는다 */
  const h3 = TH.emptyHist();
  for (let i = 0; i < 40; i++) TH.histObserve(h3, [trainAt("5400", "강일", "1", KST(11, 0), "하남검단산")], KST(11, 0) + i * 20000);
  assert.equal(TH.isParked(h3, "5400"), false);
  assert.equal(h3.trains["5400"].v[0][4], 1);
});

test("이력 — 저장/합치기 왕복: 웹·서버·인스턴스 간 이력을 합쳐도 방문이 겹치지 않는다", () => {
  const feedAt = scenario();
  const a = TH.emptyHist(), b = TH.emptyHist();
  for (let t = KST(11, 42); t <= KST(12, 0); t += 15000) TH.histObserve(a, feedAt(t), t);
  for (let t = KST(11, 55); t <= KST(12, 30); t += 15000) TH.histObserve(b, feedAt(t), t);
  const m = TH.histMerge(TH.histUnpack(JSON.parse(JSON.stringify(TH.histPack(a)))), TH.histUnpack(JSON.parse(JSON.stringify(TH.histPack(b)))));
  const v = m.trains["5197"].v;
  assert.equal(v.length, 1, "상일동 한 방문");
  assert.equal(v[0][1], KST(11, 42));
  assert.ok(v[0][2] >= KST(12, 29, 40));
  assert.deepEqual(m.trains["5055"].v.map((x) => x[0]), ["고덕", "상일동", "강일"]);
  TH.histPrune(m, KST(13, 20));
  assert.equal(m.trains["5049"], undefined, "60분 넘은 열차는 버린다");
});

test("환승 자동 승차 — 운행 대기 열차는 태우지 않는다", () => {
  const legs = [{ line: "8호선", to: "천호", min: 4, stations: ["잠실", "석촌", "송파", "천호"] },
                { line: "5호선", to: "하남검단산", min: 6, stations: ["천호", "강동", "길동", "하남검단산"] }];
  const tk = { no: "8001", line: "8호선", legIdx: 0, legTo: "천호", legs };
  const list = [trainAt("5197", "천호", "1", KST(12, 0), "하남검단산"), trainAt("5055", "천호", "0", KST(12, 0), "하남검단산")];
  assert.equal(TS.pickNextTrain(tk, list, KST(12, 0)).no, "5197", "기본은 첫 열차");
  assert.equal(TS.pickNextTrain(tk, list, KST(12, 0), { skip: (no) => no === "5197" }).no, "5055");
  assert.equal(TS.pickNextTrain(tk, [list[0]], KST(12, 0), { skip: () => true }), null);
});

test("탄 열차 자동 교체(서버) — 5197 상일동 47분 대기 중 5055 가 상일동→강일 → 5055 로 교체, 이후 남은 시간이 줄고 하남풍산 도착", () => {
  const { log } = runServer(scenario({ opposite: true }));
  const sw = log.find((l) => l.x.note === "switch");
  assert.ok(sw, "교체가 일어나야 한다");
  /* 5055 의 강일 기록(12:28:09)이 피드에 보인(+15초) 뒤 첫 틱 */
  assert.ok(sw.now >= KST(12, 28, 24) && sw.now < KST(12, 28, 24) + 50000, `교체 시각 ${new Date(sw.now).toISOString()}`);
  for (const l of log.filter((l) => l.now < sw.now)) {
    assert.equal(l.x.track.no, "5197", "그 전에는 바꾸지 않는다(5049 는 대기 시작 전에 떠났다, 반대 방향 5100 은 무시)");
  }
  assert.equal(sw.x.track.no, "5055");
  assert.equal(sw.x.track.switchedFrom, "5197");
  assert.equal(sw.x.track.dest, "하남검단산");
  assert.equal(sw.x.track.dwell, null);
  assert.equal(sw.x.push.priority, 10);
  assert.equal(sw.x.state.waiting, false, "출발 대기 해제");
  assert.equal(sw.x.state.nextStation, "미사");
  assertShape(sw.x.state, "switch");
  const after = log.filter((l) => l.now >= sw.now);
  for (const l of after) assert.equal(l.x.track.no, "5055", "다시 5197 로 돌아가지 않는다");
  const rem = after.filter((l) => !l.x.remove).map((l) => l.x.state.remainMin);
  for (let i = 1; i < rem.length; i++) assert.ok(rem[i] <= rem[i - 1], `남은 시간이 늘면 안 된다: ${rem}`);
  assert.ok(rem[0] > rem[rem.length - 1] || after.some((l) => l.x.remove), `남은 시간이 줄어야 한다: ${rem}`);
  const end = log[log.length - 1];
  assert.equal(end.x.push.event, "end", "하남풍산 도착으로 끝난다");
});

test("탄 열차 자동 교체(서버) — 다른 열차가 없으면 대기만(교체 없음), 반대 방향 열차만 지나가도 교체 없음", () => {
  const a = runServer(scenario({ with5055: false }));
  assert.ok(a.log.every((l) => l.x.track.no === "5197" && l.x.note !== "switch"));
  assert.ok(a.log.some((l) => l.x.note === "dwell"), "출발 대기 표시는 그대로");
  const b = runServer(scenario({ with5055: false, opposite: true }));
  assert.ok(b.log.every((l) => l.x.track.no === "5197"), "반대 방향(updnLine 0, 방화행)은 교체 근거가 아니다");
});

test("탄 열차 자동 교체(서버) — 정상 40초 정차 후 출발하면 교체하지 않는다(뒤따르는 열차가 있어도)", () => {
  const feedAt = scenario({ parked: false, shortDwell: true });
  const { log } = runServer(feedAt, { from: KST(11, 49), to: KST(11, 58) });
  assert.ok(log.every((l) => l.x.track.no === "5197" && l.x.note !== "switch"));
  assert.equal(log[log.length - 1].x.push.event, "end", "5197 로 하남풍산 도착");
});

test("탄 열차 자동 교체 — 추적 시작 훨씬 전에 떠난 열차로는 바꾸지 않는다(since 하한)", () => {
  /* 5197 이 11:42 부터 서 있고 5061 이 11:45 에 상일동→강일. 사용자는 12:00 에 5197 을 골랐다 → 5061 은 사용자의 열차가 아니다 */
  const h = TH.emptyHist();
  const obs = (no, stn, st, at, u = "1") => TH.histObserve(h, [Object.assign(trainAt(no, stn, st, at, "하남검단산"), { updnLine: u })], at + 15000);
  for (let t = KST(11, 42); t <= KST(12, 10); t += 20000) obs("5197", "상일동", "1", t);
  obs("5061", "상일동", "1", KST(11, 45)); obs("5061", "강일", "1", KST(11, 47));
  assert.equal(TH.findSwitch(h, { no: "5197", stations: LEG, since: KST(12, 0) }), null);
  assert.equal(TH.findSwitch(h, { no: "5197", stations: LEG, since: KST(11, 44) }).no, "5061", "추적을 그 전에 시작했으면 바꾼다");
  /* 여러 대면 상일동을 가장 먼저 떠난 열차 */
  obs("5063", "상일동", "1", KST(11, 46)); obs("5063", "강일", "1", KST(11, 48));
  assert.equal(TH.findSwitch(h, { no: "5197", stations: LEG, since: KST(11, 44) }).no, "5061");
  /* 종착역이 X 이전(회차)인 열차는 아니다 */
  const h2 = TH.emptyHist();
  for (let t = KST(11, 42); t <= KST(12, 10); t += 20000) TH.histObserve(h2, [trainAt("5197", "상일동", "1", t, "하남검단산")], t + 15000);
  TH.histObserve(h2, [trainAt("5070", "상일동", "1", KST(12, 0), "상일동")], KST(12, 0, 15));
  TH.histObserve(h2, [trainAt("5070", "강일", "1", KST(12, 2), "상일동")], KST(12, 2, 15));
  assert.equal(TH.findSwitch(h2, { no: "5197", stations: LEG, since: KST(11, 50) }), null);
});

test("handler — 틱이 노선 이력을 sf_cache(ssl:la:hist:<노선>)에 저장하고, op=hist 로 돌려준다(시크릿 불필요)", async () => {
  envUp();
  handler._memHist.clear();
  const now = Date.now();
  const tripRow = { date: "ssl:la:h1", events: { tripId: "h1", token: "tok", env: "prod", attrs: { to: "하남풍산" }, state: prevState(),
    track: legTrack({ since: now - 60000, line: "6호선" }), paused: false, expires_at: new Date(now + 3600000).toISOString() }, updated_at: new Date(now).toISOString() };
  const f = installFetch({ rows: [tripRow], feed: [trainAt("5197", "상일동", "1", now - 20000, "하남검단산")] });
  const pz = fakePusher();
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.code, 200);
    const w = f.seen.writes.find((x) => x.method === "POST" && JSON.stringify(x.body).includes("ssl:la:hist:6호선"));   /* 6호선: 앞 테스트들의 5호선 피드 캐시(4초)를 피한다 */
    assert.ok(w, "노선 이력 저장");
    assert.equal(w.body[0].events.trains["5197"].v[0][0], "상일동");
    assert.ok(f.seen.urls.some((u) => u.includes("not.like")), "주행 목록 조회는 이력 행을 받아 오지 않는다");
    assert.ok(f.seen.urls.some((u) => decodeURIComponent(u).includes("date=neq.ssl:la:parked")), "운행 대기 등록부 행도 받아 오지 않는다");
    assert.ok(f.seen.writes.some((x) => JSON.stringify(x.body || "").includes("ssl:la:parked")), "틱이 노선 활동을 등록부에 남긴다(op=kick 이 이어 받게)");
    const h = await call({ query: { op: "hist", line: "6호선" } });
    assert.equal(h.code, 200);
    assert.equal(h.body.hist.trains["5197"].v[0][0], "상일동");
    assert.equal((await call({ query: { op: "hist", line: "없는선" } })).code, 400);
  } finally { f.restore(); pz.restore(); handler._memHist.clear(); }
});

test("sf_cache — 노선 이력 행은 주행으로 읽지 않는다", () => {
  const store = require("../lib/supabase.js");
  assert.equal(store.toTrip({ date: "ssl:la:hist:5호선", events: { trains: {}, at: 0 } }), null);
});

test("handler — op=hist: 이력이 묵었으면 피드를 한 번 받아 쌓고 저장(노선당 20초에 한 번), 첫 요청도 한 장면을 돌려준다", async () => {
  envUp();
  handler._memHist.clear();
  const now = Date.now();
  const f = installFetch({ rows: [], feed: [trainAt("7101", "군자", "1", now - 20000, "장암")] });
  try {
    const a = await call({ query: { op: "hist", line: "7호선" } });
    assert.equal(a.code, 200);
    assert.equal(a.body.observed, true);
    assert.equal(a.body.hist.trains["7101"].v[0][0], "군자", "첫 요청도 현재 한 장면");
    assert.ok(f.seen.writes.some((w) => w.method === "POST" && JSON.stringify(w.body).includes("ssl:la:hist:7호선")), "저장");
    const feeds = () => f.seen.urls.filter((u) => u.includes("swopenapi")).length;
    const n = feeds();
    const b = await call({ query: { op: "hist", line: "7호선" } });
    assert.equal(b.body.observed, false, "20초 안 재요청은 피드를 다시 부르지 않는다");
    assert.equal(feeds(), n);
  } finally { f.restore(); handler._memHist.clear(); }
});

/* ── 열차번호 충돌 — 번호는 노선끼리 겹친다(실측 2026-09-24 14:41: 5호선 5073 상일동→하남검단산 ↔ 경의중앙선 5073 서빙고→용문) ── */
test("열차번호 충돌 — 경의중앙선 5073 이 5호선 5073 추적(피드 찾기·이력·computeRow)에 섞이지 않는다", () => {
  const now = KST(14, 41, 30);
  const t5 = Object.assign(trainAt("5073", "상일동", "1", KST(14, 40, 40), "하남검단산"), { subwayNm: "5호선" });
  const tg = Object.assign(trainAt("5073", "서빙고", "1", KST(14, 41, 0), "용문"), { subwayNm: "경의중앙선", updnLine: "0" });   /* 더 최근 수신 */
  /* 피드 찾기: 노선을 주면 그 노선 열차만 — 안 주면(예전) 더 최근인 경의중앙선 행을 잡는다 */
  assert.equal(TS.findTrain([t5, tg], "5073", "5호선").statnNm, "상일동");
  assert.equal(TS.findTrain([t5, tg], "5073").statnNm, "서빙고", "노선 없이 찾으면 섞인다(그래서 computeRow 는 track.line 을 넘긴다)");
  assert.equal(TS.dedupByTrainNo([t5, tg]).length, 2, "노선이 다르면 같은 번호라도 둘 다 남긴다");
  /* 이력은 노선별 — 5호선 이력에 경의중앙선 행이 섞여 와도 5호선 5073 만 */
  const h5 = TH.emptyHist(), hg = TH.emptyHist();
  TH.histObserve(h5, [t5, tg], now, "5호선");
  TH.histObserve(hg, [tg], now, "경의중앙선");
  assert.equal(h5.trains["5073"].v.length, 1);
  assert.equal(h5.trains["5073"].v[0][0], "상일동");
  assert.equal(hg.trains["5073"].v[0][0], "서빙고");
  const hists = { "5호선": h5, "경의중앙선": hg };
  const row = (track) => ({ trip_id: "c", token: "tok", attrs: { to: "하남풍산" }, state: prevState({ nextStation: "강일", legTo: "하남풍산" }), track,
    last_push_at: new Date(now).toISOString() });
  const track = legTrack({ no: "5073", since: KST(14, 41) });
  const clean = computeRow(row(track), feedOf({ "5호선": [t5], "경의중앙선": [tg] }), now, (ln) => hists[ln]);
  const dirty = computeRow(row(track), feedOf({ "5호선": [t5, tg], "경의중앙선": [tg] }), now, (ln) => hists[ln]);
  assert.notEqual(clean.note, "train-not-in-feed");
  assert.notEqual(clean.note, "unknown-position");
  assert.equal(clean.state.nextStation, "강일", "상일동의 5호선 5073 기준");
  assert.deepEqual(dirty.state, clean.state, "같은 번호 경의중앙선 행이 5호선 피드에 섞여도 결과가 같다");
  assert.equal(dirty.track.no, "5073"); assert.equal(dirty.track.line, "5호선");
  assert.ok(!dirty.switched);
  /* 경의중앙선 피드만 있는 경우(5호선 피드엔 5073 없음) — 경의중앙선 5073 을 5호선 열차로 잡지 않는다 */
  const lost = computeRow(row(track), feedOf({ "5호선": [], "경의중앙선": [tg] }), now, (ln) => hists[ln]);
  assert.equal(lost.note, "train-not-in-feed");
  /* 환승 자동 승차도 노선까지 맞는 열차만 */
  const xfer = legTrack({ no: "5001", legTo: "왕십리", legEndedAt: now - 5 * 60000,
    legs: [{ line: "5호선", to: "왕십리", min: 6 }, { line: "경의중앙선", to: "옥수", min: 4, stations: ["왕십리", "응봉", "옥수"] }] });
  const wrong = Object.assign(trainAt("5073", "왕십리", "1", KST(14, 41), "용문"), { subwayNm: "5호선" });   /* 경의중앙선 피드에 5호선 행 */
  const nb = TS.pickNextTrain(xfer, [wrong], now);
  assert.equal(nb, null, "다른 노선 행으로 환승 열차를 잡지 않는다");
});

/* ── 운행 대기 등록부(sf_cache 'ssl:la:parked') ── */
const p5 = (no, stn, st, at, term = "하남검단산") => Object.assign(trainAt(no, stn, st, at, term), { subwayNm: "5호선" });
function parkedHist(from, to) {
  const h = TH.emptyHist();
  for (let t = from; t <= to; t += 20000) TH.histObserve(h, [p5("5197", "상일동", "1", t)], t + 15000, "5호선");
  return h;
}
test("운행 대기 등록부 — 기록: 8분 넘게 선 열차를 {line,no,stn,since,lastSeen} 로 남긴다(같은 번호 다른 노선과 따로)", () => {
  const reg = TH.emptyReg();
  const h = parkedHist(KST(11, 42), KST(13, 0));
  assert.equal(TH.regUpdate(reg, "5호선", h, KST(13, 0, 15)), true);
  const e = reg.trains["5호선|5197"];
  assert.deepEqual(e, { line: "5호선", no: "5197", stn: "상일동", since: KST(11, 42), lastSeen: KST(13, 0) });
  assert.equal(TH.regUpdate(reg, "5호선", h, KST(13, 0, 15)), false, "같은 내용이면 바뀐 것 없음");
  /* 짧은 정차는 남기지 않는다 */
  const reg2 = TH.emptyReg();
  TH.regUpdate(reg2, "5호선", parkedHist(KST(11, 42), KST(11, 45)), KST(11, 45, 15));
  assert.equal(Object.keys(reg2.trains).length, 0);
  /* 다른 노선의 같은 번호는 영향 없음 */
  const hg = TH.emptyHist();
  TH.histObserve(hg, [Object.assign(trainAt("5197", "서빙고", "1", KST(13, 0), "용문"), { subwayNm: "경의중앙선" })], KST(13, 0, 15), "경의중앙선");
  TH.regUpdate(reg, "경의중앙선", hg, KST(13, 0, 15));
  assert.ok(reg.trains["5호선|5197"]);
  assert.ok(!reg.trains["경의중앙선|5197"]);
});

test("운행 대기 등록부 — 아무도 안 보던 1시간 40분 뒤 같은 역에 다시 보이면 곧바로 운행 대기(since 는 등록부), 다른 역·출발(2)이면 지운다", () => {
  const reg = TH.emptyReg();
  TH.regUpdate(reg, "5호선", parkedHist(KST(11, 42), KST(13, 0)), KST(13, 0, 15));
  /* 14:39 — 서버 이력은 60분 보관이라 비었다: 처음 본 것처럼 한 장면 */
  const h = TH.emptyHist();
  TH.histObserve(h, [p5("5197", "상일동", "1", KST(14, 39)), p5("5073", "상일동", "1", KST(14, 39))], KST(14, 39, 15), "5호선");
  assert.equal(TH.parkedInfo(h.trains["5197"]), null, "등록부 없이는 방금 도착으로 보인다(버그)");
  TH.regUpdate(reg, "5호선", h, KST(14, 39, 15));
  const pi = TH.parkedInfo(h.trains["5197"]);
  assert.ok(pi, "곧바로 운행 대기");
  assert.equal(pi.since, KST(11, 42));
  assert.equal(Math.floor(pi.durMs / 60000), 177);
  assert.equal(reg.trains["5호선|5197"].lastSeen, KST(14, 39));
  assert.equal(TH.isParked(h, "5073"), false, "막 들어온 5073 은 아니다");
  /* 환승 자동 승차도 운행 대기 열차는 건너뛴다(isParked) */
  const xfer = legTrack({ no: "5000", legTo: "상일동", legEndedAt: KST(14, 30), legs: [{ line: "5호선", to: "상일동", min: 6 },
    { line: "5호선", to: "하남풍산", min: 6, stations: ["상일동", "강일", "미사", "하남풍산"] }] });
  const nb = TS.pickNextTrain(xfer, [p5("5197", "상일동", "1", KST(14, 39))], KST(14, 40), { skip: (no) => TH.isParked(h, no) });
  assert.equal(nb, null);
  /* 다른 역에서 보이면 즉시 지운다 */
  TH.histObserve(h, [p5("5197", "강일", "1", KST(14, 45))], KST(14, 45, 15), "5호선");
  assert.equal(TH.regUpdate(reg, "5호선", h, KST(14, 45, 15)), true);
  assert.ok(!reg.trains["5호선|5197"]);
  /* 그 역에서 출발(2)해도 지운다 */
  const reg2 = TH.emptyReg();
  const h2 = parkedHist(KST(11, 42), KST(12, 0));
  TH.regUpdate(reg2, "5호선", h2, KST(12, 0, 15));
  assert.ok(reg2.trains["5호선|5197"]);
  TH.histObserve(h2, [p5("5197", "상일동", "2", KST(12, 1))], KST(12, 1, 15), "5호선");
  TH.regUpdate(reg2, "5호선", h2, KST(12, 1, 15));
  assert.ok(!reg2.trains["5호선|5197"]);
  assert.equal(TH.parkedInfo(h2.trains["5197"]), null);
});

test("운행 대기 등록부 — 6시간 못 본 항목은 가지치기, 오래된 항목은 되살리지 않는다, 합치기·왕복", () => {
  const reg = TH.regUnpack({ trains: {
    "5호선|5197": { line: "5호선", no: "5197", stn: "상일동", since: KST(5, 0), lastSeen: KST(6, 0) },
    "5호선|5073": { line: "5호선", no: "5073", stn: "상일동", since: KST(11, 0), lastSeen: KST(12, 0) },
  }, lines: { "5호선": KST(6, 0), "7호선": KST(12, 0) }, at: KST(12, 0) });
  assert.equal(TH.regPrune(reg, KST(12, 30)), true);
  assert.deepEqual(Object.keys(reg.trains), ["5호선|5073"]);
  assert.deepEqual(Object.keys(reg.lines), ["7호선"]);
  /* regUpdate 도 6시간 지난 항목의 since 를 쓰지 않는다 */
  const reg2 = TH.regUnpack({ trains: { "5호선|5197": { line: "5호선", no: "5197", stn: "상일동", since: KST(5, 0), lastSeen: KST(6, 0) } } });
  const h = TH.emptyHist();
  TH.histObserve(h, [p5("5197", "상일동", "1", KST(12, 30))], KST(12, 30, 15), "5호선");
  TH.regUpdate(reg2, "5호선", h, KST(12, 30, 15));
  assert.equal(TH.parkedInfo(h.trains["5197"]), null);
  assert.ok(!reg2.trains["5호선|5197"]);
  /* 합치기: 같은 역이면 since 는 이른 쪽·lastSeen 은 늦은 쪽 */
  const a = TH.regUnpack({ trains: { "5호선|5197": { line: "5호선", no: "5197", stn: "상일동", since: KST(11, 50), lastSeen: KST(14, 0) } } });
  TH.regMerge(a, [{ line: "5호선", no: "5197", stn: "상일동", since: KST(11, 42), lastSeen: KST(13, 0) }]);
  assert.deepEqual(a.trains["5호선|5197"], { line: "5호선", no: "5197", stn: "상일동", since: KST(11, 42), lastSeen: KST(14, 0) });
  assert.deepEqual(TH.regForLine(a, "5호선").map((e) => e.no), ["5197"]);
  assert.deepEqual(TH.regForLine(a, "경의중앙선"), []);
  assert.equal(store.toTrip({ date: "ssl:la:parked", events: { trains: {}, lines: {}, at: 0 } }), null, "등록부 행은 주행이 아니다");
});

test("handler — op=hist 는 등록부를 이력에 되돌려 쓰고 그 노선 등록부 항목(parked)을 함께 돌려준다", async () => {
  envUp();
  handler._memHist.clear(); handler._resetParked();
  const now = Date.now();
  const since = now - 3 * 3600e3;
  const parkedRow = { date: "ssl:la:parked", events: { trains: { "9호선|9100": { line: "9호선", no: "9100", stn: "가양", since, lastSeen: now - 90 * 60000 } }, lines: {}, at: now - 90 * 60000 } };
  const f = installFetch({ rows: [parkedRow], feed: [Object.assign(trainAt("9100", "가양", "1", now - 20000, "중앙보훈병원"), { subwayNm: "9호선" })] });
  try {
    const r = await call({ query: { op: "hist", line: "9호선" } });
    assert.equal(r.code, 200);
    assert.equal(r.body.parked.length, 1);
    assert.equal(r.body.parked[0].no, "9100");
    assert.equal(r.body.hist.trains["9100"].v[0][1], since, "처음 본 기록이지만 정차 시작은 등록부 값");
    assert.ok(TH.parkedInfo(TH.histUnpack(r.body.hist).trains["9100"]));
    const w = f.seen.writes.find((x) => JSON.stringify(x.body || "").includes("ssl:la:parked"));
    assert.ok(w, "등록부 저장(lastSeen·활동 노선)");
    assert.ok(w.body[0].events.lines["9호선"] >= now, "이 노선 최근 활동");
  } finally { f.restore(); handler._memHist.clear(); handler._resetParked(); }
});

test("handler — op=kick 은 등록부 노선의 이력을 우선 이어 받고(최대 3노선), 남는 예산은 라운드로빈으로 채운다(전체 최대 4노선)", async () => {
  envUp();
  handler._memHist.clear(); handler._resetParked();
  const now = Date.now();
  const since = now - 2 * 3600e3;
  const parkedRow = { date: "ssl:la:parked", events: { trains: { "8호선|8123": { line: "8호선", no: "8123", stn: "암사", since, lastSeen: now - 30 * 60000 } }, lines: {}, at: now - 30 * 60000 } };
  const f = installFetch({ rows: [parkedRow], lock: { id: "other", until: now + 60000 },
    feed: [Object.assign(trainAt("8123", "암사", "1", now - 20000, "모란"), { subwayNm: "8호선" })] });
  try {
    const r = await call({ query: { op: "kick" } });
    assert.equal(r.body.kicked, false);
    assert.equal(r.body.reason, "locked");
    /* 우선순위(등록부) 8호선 + 커서 0부터 라운드로빈으로 채운 3노선 = 전체 4노선 상한 */
    assert.equal(r.body.hist.length, 4, "우선순위 + 라운드로빈 = 전체 4노선 상한");
    assert.ok(r.body.hist.includes("8호선"), "등록부 노선이 우선 포함된다");
    assert.deepEqual(new Set(r.body.hist), new Set(["8호선", "1호선", "2호선", "3호선"]), "커서 0부터 라운드로빈으로 남는 예산을 채운다");
    assert.ok(f.seen.urls.some((u) => u.includes("swopenapi") && decodeURIComponent(u).includes("8호선")), "8호선 피드 조회");
    assert.ok(f.seen.writes.some((w) => JSON.stringify(w.body || "").includes("ssl:la:hist:8호선")), "이력 저장");
    assert.ok(f.seen.writes.some((w) => JSON.stringify(w.body || "").includes("ssl:la:scan")), "라운드로빈 커서 저장");
    const w = f.seen.writes.find((x) => JSON.stringify(x.body || "").includes("ssl:la:parked"));
    assert.ok(w, "등록부 저장");
    const e = w.body[0].events.trains["8호선|8123"];
    assert.equal(e.since, since, "정차 시작 유지");
    assert.ok(e.lastSeen > now - 30 * 60000, "lastSeen 갱신");
    const n8 = f.seen.urls.filter((u) => u.includes("swopenapi") && decodeURIComponent(u).includes("8호선")).length;
    const r2 = await call({ query: { op: "kick" } });
    /* 8호선은 60초 안에는 다시 받지 않는다 — 라운드로빈이 다른(아직 안 받은) 노선을 대신 채운다 */
    assert.ok(!(r2.body.hist || []).includes("8호선"), "8호선은 60초 안에는 다시 받지 않는다");
    assert.equal(f.seen.urls.filter((u) => u.includes("swopenapi") && decodeURIComponent(u).includes("8호선")).length, n8, "8호선 재조회 없음");
  } finally { f.restore(); handler._memHist.clear(); handler._resetParked(); }
});

test("handler — op=kick 라운드로빈: 우선순위 노선이 없어도 커서부터 ALLOWED 전체를 최대 4노선까지 채운다", async () => {
  envUp();
  handler._memHist.clear(); handler._resetParked();
  const now = Date.now();
  /* 커서를 노선 배열 가운데(9호선=인덱스 8)로 미리 저장 — 다음 kick 은 여기부터 이어 돈다 */
  const scanRow = { date: "ssl:la:scan", events: { i: 8, at: now - 5 * 60000 } };
  const f = installFetch({ rows: [scanRow], lock: { id: "other", until: now + 60000 }, feed: [] });
  try {
    const r = await call({ query: { op: "kick" } });
    assert.equal(r.body.kicked, false);
    /* 커서 8("9호선")부터 4노선: 9호선·수인분당선·신분당선·경강선. 빈 피드는 관측이 없어 hist 목록엔 안 남지만 조회는 한다 */
    assert.equal(r.body.hist, undefined);
    const tried = [...new Set(f.seen.urls.filter((u) => u.includes("swopenapi")).map((u) => decodeURIComponent(u)))];
    assert.equal(tried.length, 4, "전체 상한(4노선)을 지킨다");
    for (const ln of ["9호선", "수인분당선", "신분당선", "경강선"]) {
      assert.ok(tried.some((u) => u.includes(ln)), `${ln} 조회`);
    }
    const w = f.seen.writes.find((x) => JSON.stringify(x.body || "").includes("ssl:la:scan"));
    assert.ok(w, "커서 저장");
    assert.equal(w.body[0].events.i, (8 + 4) % 18, "커서가 훑은 만큼 전진한다");
  } finally { f.restore(); handler._memHist.clear(); handler._resetParked(); }
});

/* ── 환승 대기에서 멈춘 잠금화면(2026-09-24 19:55 실측: 상일동→(5호선)→청구→(6호선)→이태원, '1분 후 출발' 에서 stale) ──
   6호선 청구에서 이태원 방면 열차의 종착(응암순환(상선)·새절)이 구간 역 목록 밖이라 서버가 방향을 몰라 영원히 대기했다.
   웹이 구간마다 dirTerms(노선 그래프로 구한 '이 방향 종착 후보')·before(직전 역)를 보낸다(index.html legDirInfo). */
const L5_SI = ["상일동", "고덕", "명일", "굽은다리", "길동", "강동", "천호", "광나루", "아차산", "군자", "장한평", "답십리", "마장", "왕십리", "행당", "신금호", "청구"];
const L6_CI = ["청구", "약수", "버티고개", "한강진", "이태원"];
/* index.html legDirInfo 가 실제 노선도로 낸 값(청구→이태원) */
const DIR6 = ["이태원", "녹사평", "삼각지", "효창공원앞", "공덕", "대흥", "광흥창", "상수", "합정", "망원", "마포구청", "월드컵경기장",
  "디지털미디어시티", "증산", "새절", "응암", "역촌", "구산", "불광", "연신내", "독바위"];
function siRow(now, { dir = true } = {}) {
  const legs = [
    { line: "5호선", to: "청구", min: 32, stations: L5_SI },
    Object.assign({ line: "6호선", to: "이태원", min: 8, stations: L6_CI }, dir ? { dirTerms: DIR6, before: [["신당", "동묘앞"]] } : {}),
  ];
  return {
    trip_id: "si", token: "tok-si", env: "prod", attrs: { from: "상일동", to: "이태원", transfers: 1 },
    state: prevState({ line: "5호선", legTo: "청구", isLast: false, nextStation: "신금호", remainMin: 15, toLine: "6호선", toColorHex: "#CD7C2F" }),
    track: { no: "5301", line: "5호선", legIdx: 0, stations: L5_SI, legTo: "청구", isLast: false, laterMin: 5 + 8, dest: "마천",
      stops: null, approach: [], legs },
    last_push_at: new Date(now).toISOString(), last_progress_at: new Date(now).toISOString(),
  };
}
const t6 = (no, stn, st, term, u = "1") => ({ subwayNm: "6호선", trainNo: no, statnNm: stn, trainSttus: st, statnTnm: term, updnLine: u });
const t5 = (no, stn, st) => ({ subwayNm: "5호선", trainNo: no, statnNm: stn, trainSttus: st, statnTnm: "마천", updnLine: "0" });
const iso = (ms) => new Date(ms).toISOString();
/* api/la.js 한 라운드처럼: computeRow → overdueEnd → (푸시 성공 가정) 저장 */
function simulate(row, feedAt, from, to, step = 50000) {
  const out = [];
  let r = Object.assign({}, row);
  for (let now = from; now <= to; now += step) {
    const x0 = computeRow(r, feedAt(now), now);
    const x = LA.overdueEnd(r, x0, now) || x0;
    out.push({ now, x });
    if (x.remove) break;
    const moved = LA.progressKey(x.state, x.track) !== LA.progressKey(r.state, r.track);
    r = Object.assign({}, r, { state: x.state, track: x.track, last_push_at: x.push ? iso(now) : r.last_push_at,
      last_feed_at: iso(now), last_progress_at: moved ? iso(now) : r.last_progress_at });
  }
  return out;
}
const T0 = Date.UTC(2026, 8, 24, 10, 40);   /* 19:40 KST */
const M_ = 60000;

test("환승 청구→이태원 — 종착이 구간 밖(응암순환(상선))인 6호선 열차를 dirTerms 로 태우고, 신내행은 태우지 않는다 → 이태원 도착 end", () => {
  const feedAt = (now) => {
    const f5 = now < T0 + M_ ? [t5("5301", "신금호", "2")] : [t5("5301", "청구", "1")];
    const f6 = [t6("6101", "청구", "1", "신내", "0")];                                   /* 반대 방향이 내내 서 있다 */
    const e = now - (T0 + 5 * M_);                                                       /* 19:45 부터 응암순환행이 온다 */
    if (e >= 0) {
      const at = Math.min(L6_CI.length - 1, Math.floor(e / (2 * M_)));
      f6.push(t6("6102", L6_CI[at], at === 0 ? "0" : "1", "응암순환(상선)"));
    }
    return feedOf({ "5호선": f5, "6호선": f6 });
  };
  const log = simulate(siRow(T0), feedAt, T0, T0 + 30 * M_);
  const notes = log.map((l) => l.x.note);
  const legEnd = log.find((l) => l.x.note === "leg-end");
  assert.ok(legEnd, "청구에서 구간 종료");
  const board = log.find((l) => l.x.note === "auto-board");
  assert.ok(board, "자동 승차: " + notes.join(","));
  assert.equal(board.x.track.no, "6102");
  assert.equal(board.x.track.line, "6호선");
  assert.ok(!log.some((l) => l.x.track && l.x.track.no === "6101"), "신내행(반대 방향)은 태우지 않는다");
  const last = log[log.length - 1].x;
  assert.equal(last.push.event, "end");
  assert.equal(last.state.done, true);
  assert.deepEqual(last.push.alert, { title: "목적지 도착", body: "이태원에 도착했습니다" });
  for (const l of log) if (l.x.state && l.x.state.remainMin != null) assertShape(l.x.state, l.x.note);
});

test("환승 청구→이태원 — pickNextTrain: 새절행·응암순환행 승차, 신내행·환승역 종착·운행 대기 제외, 다가오는 열차(직전 2정거장) 허용", () => {
  const row = siRow(T0);
  const tk = row.track;
  assert.equal(TS.pickNextTrain(tk, [t6("6101", "청구", "1", "신내", "0")]), null);
  assert.equal(TS.pickNextTrain(tk, [t6("6103", "청구", "1", "새절")]).no, "6103");
  assert.equal(TS.pickNextTrain(tk, [t6("6104", "청구역", "0", "응암순환(상선)")]).no, "6104");
  assert.equal(TS.pickNextTrain(tk, [t6("6105", "청구", "1", "청구")]), null, "환승역에서 끝나는 열차");
  assert.equal(TS.pickNextTrain(tk, [t6("6103", "청구", "1", "새절")], Date.now(), { skip: (no) => no === "6103" }), null, "운행 대기");
  /* 다가오는 열차: 신당(1정거장 전) 전역출발 → approach=[신당], 동묘앞(2정거장 전) → [동묘앞, 신당]. 출발(2)·3정거장 전은 아님 */
  const a1 = TS.pickNextTrain(tk, [t6("6106", "신당", "3", "응암순환(상선)")]);
  assert.deepEqual([a1.no, a1.approach], ["6106", ["신당"]]);
  const a2 = TS.pickNextTrain(tk, [t6("6107", "동묘앞", "1", "새절")]);
  assert.deepEqual([a2.no, a2.approach], ["6107", ["동묘앞", "신당"]]);
  assert.equal(TS.pickNextTrain(tk, [t6("6108", "신당", "2", "새절")]), null);
  assert.equal(TS.pickNextTrain(tk, [t6("6109", "창신", "1", "새절")]), null);
  /* 여럿이면 환승역에 가까운 열차 */
  assert.equal(TS.pickNextTrain(tk, [t6("6107", "동묘앞", "1", "새절"), t6("6110", "청구", "0", "새절"), t6("6106", "신당", "3", "새절")]).no, "6110");
  /* 다가오는 열차를 태우면 주행 계산은 '대기 중 · N분 후 출발' */
  const res = applyTrack(a1, t6("6106", "신당", "3", "응암순환(상선)"), {}, Date.now());
  assert.equal(res.phase, "approach");
  assert.equal(res.state.waiting, true);
  /* dirTerms 가 없는 옛 웹 행: 예전처럼 구간 목록 밖 종착은 판단하지 않는다 */
  assert.equal(TS.pickNextTrain(siRow(T0, { dir: false }).track, [t6("6103", "청구", "1", "새절")]), null);
  /* 순환선: loopDir 로 updnLine 을 본다, 지선 종착(offTerms)은 제외 */
  const legs2 = [{ line: "5호선", to: "왕십리", min: 12 },
    { line: "2호선", to: "건대입구", min: 8, stations: L2, loopDir: "0", before: [["상왕십리", "신당"]], offTerms: ["용답", "신답", "용두", "신설동"] }];
  const tk2 = { legIdx: 0, legTo: "왕십리", legs: legs2 };
  const t2 = (no, stn, st, term, u) => ({ subwayNm: "2호선", trainNo: no, statnNm: stn, trainSttus: st, statnTnm: term, updnLine: u });
  assert.equal(TS.pickNextTrain(tk2, [t2("2201", "왕십리", "1", "성수", "1")]), null, "외선");
  assert.equal(TS.pickNextTrain(tk2, [t2("2202", "왕십리", "1", "시청", "0")]).no, "2202", "내선 — 종착이 구간 밖이어도");
  assert.equal(TS.pickNextTrain(tk2, [t2("2203", "왕십리", "1", "신설동", "0")]), null, "지선 열차");
});

test("환승 대기 — 열차가 끝내 안 오면 7분 뒤 시간 기준으로 진행하고(대기에 멈추지 않음) 도착 예정 뒤 도착 end", () => {
  const feedAt = (now) => feedOf({ "5호선": now < T0 + M_ ? [t5("5301", "신금호", "2")] : [t5("5301", "청구", "1")],
    "6호선": [t6("6101", "청구", "1", "신내", "0")] });                                   /* 반대 방향뿐 */
  const log = simulate(siRow(T0), feedAt, T0, T0 + 60 * M_);
  const endAt = log.find((l) => l.x.note === "leg-end").now;
  const waits = log.filter((l) => l.x.note === "waiting");
  assert.ok(waits.length && waits.every((l) => l.now - endAt < LA.XFER_FALLBACK_MS), "대기는 7분 안에서만");
  const tb = log.filter((l) => l.x.note === "time-based");
  assert.ok(tb.length > 3, "시간 기준 진행");
  assert.equal(tb[0].x.state.waiting, false, "탔다고 본다");
  assert.equal(tb[0].x.push && tb[0].x.push.event, "update", "상태가 바뀌었으니 곧바로 푸시");
  /* 다음 역이 약수 → 버티고개 → 한강진 → 이태원 순으로 나아가고 남은 시간이 줄어든다 */
  const seq = [...new Set(tb.map((l) => l.x.state.nextStation))];
  assert.deepEqual(seq.filter((s) => L6_CI.includes(s)), seq);
  assert.ok(seq.includes("버티고개") && seq.includes("이태원"), seq.join(","));
  for (let i = 1; i < tb.length; i++) assert.ok(tb[i].x.state.remainMin <= tb[i - 1].x.state.remainMin);
  const arrival = endAt + 5 * M_ + 8 * M_;
  assert.ok(tb.every((l) => l.x.state.endEpoch === arrival), "도착 예정 시각은 고정(매 틱 now 뒤로 밀리지 않는다)");
  const al = tb.find((l) => l.x.state.alight);
  assert.ok(al, "이태원 앞 역에서 '곧 내리세요'");
  assert.deepEqual(al.x.push.alert, { title: "곧 내리세요", body: "다음 역 이태원에서 내리세요" });
  assert.equal(al.x.push.priority, 10);
  assert.equal(tb.filter((l) => l.x.push && l.x.push.alert).length, 1, "알림은 한 번만");
  const last = log[log.length - 1];
  assert.equal(last.x.push.event, "end");
  assert.equal(last.x.state.done, true);
  assert.deepEqual(last.x.push.alert, { title: "목적지 도착", body: "이태원에 도착했습니다" });
  assert.ok(last.now >= arrival + LA.OVERDUE_GRACE_MS && last.now <= arrival + LA.TIME_DONE_GRACE_MS + 50000, `끝난 시각 +${(last.now - arrival) / M_}분`);
  for (const l of log) if (l.x.state && l.x.state.remainMin != null) assertShape(l.x.state, l.x.note);
});

test("환승 대기 — 시간 기준으로 넘어간 뒤 늦게 온 실제 열차(배차 10분)도 그 구간 동안은 태운다", () => {
  const feedAt = (now) => {
    const f6 = now >= T0 + 11 * M_ ? [t6("6102", "청구", "1", "새절")] : [];
    return feedOf({ "5호선": now < T0 + M_ ? [t5("5301", "신금호", "2")] : [t5("5301", "청구", "1")], "6호선": f6 });
  };
  const log = simulate(siRow(T0), feedAt, T0, T0 + 12 * M_);
  const notes = log.map((l) => l.x.note);
  assert.ok(notes.includes("time-based"));
  const late = log.find((l) => l.x.note === "auto-board-late");
  assert.ok(late, notes.join(","));
  assert.equal(late.x.track.no, "6102");
  assert.equal(late.x.track.legEndedAt, undefined);
});

test("출발 대기 중 탈 열차가 피드에서 사라짐 — 7분 뒤 시간 기준으로 진행(멈춘 '1분 후 출발' 금지), 다시 보이면 실제 위치로", () => {
  const now0 = T0;
  const legs = [{ line: "5호선", to: "천호", min: 26, stations: L5 }];
  const row = { trip_id: "o", token: "tok-o", attrs: { to: "천호" },
    state: prevState({ waiting: true, waitMin: 1, remainMin: 27, nextStation: "광화문" }),
    track: baseTrack({ legs, approach: ["서대문"] }), last_push_at: iso(now0), last_progress_at: iso(now0) };
  const log = simulate(row, () => feedOf({ "5호선": [] }), now0, now0 + 12 * M_);
  assert.equal(log[0].x.note, "train-not-in-feed");
  const tb = log.filter((l) => l.x.note === "time-based-lost");
  assert.ok(tb.length, log.map((l) => l.x.note).join(","));
  assert.ok(tb[0].now - now0 >= LA.XFER_FALLBACK_MS);
  assert.equal(tb[0].x.state.waiting, false);
  assert.equal(tb[tb.length - 1].x.state.nextStation !== "광화문", true);
  /* 다시 보이면 곧바로 실제 위치 */
  const r2 = Object.assign({}, row, { state: tb[0].x.state, track: tb[0].x.track });
  const x = computeRow(r2, feedOf({ "5호선": [train("5001", "청구", "1")] }), tb[0].now + 50000);
  assert.equal(x.note, "run");
  assert.equal(x.state.nextStation, "신금호");
  assert.equal(x.track.assumedBoardAt, undefined);
});

test("stale-date — 업데이트 푸시마다 지금 + max(남은 분, 2) + 3분, 하트비트는 90초 안에 반드시 한 번", () => {
  assert.equal(LA.staleSecFor(0), 5 * 60);
  assert.equal(LA.staleSecFor(1), 5 * 60);
  assert.equal(LA.staleSecFor(10), 13 * 60);
  const feedAt = (now) => feedOf({ "5호선": now < T0 + M_ ? [t5("5301", "신금호", "2")] : [t5("5301", "청구", "1")], "6호선": [] });
  const log = simulate(siRow(T0), feedAt, T0, T0 + 60 * M_);
  let lastPush = T0;
  for (const l of log) {
    const p = l.x.push;
    if (!p) continue;
    assert.ok(Number.isFinite(p.staleSec) && p.staleSec >= 60, "staleSec " + p.staleSec);
    if (p.event === "update") assert.equal(p.staleSec, LA.staleSecFor(l.x.state.remainMin));
    assert.ok(l.now - lastPush <= 90000, `푸시 간격 ${(l.now - lastPush) / 1000}s (${l.x.note})`);
    lastPush = l.now;
  }
  /* 내용이 그대로여도: 45초 지났으면 하트비트, 30초면 아직 */
  const now = Date.now();
  const hb = (ago) => computeRow({ trip_id: "t", token: "tok", state: prevState(), track: baseTrack(), last_push_at: iso(now - ago) },
    feedOf({ "5호선": [train("9999", "왕십리", "1")] }), now);
  assert.ok(hb(46000).push, "46초 → 하트비트");
  assert.equal(hb(46000).push.staleSec, LA.staleSecFor(prevState().remainMin));
  assert.equal(hb(30000).push, null, "30초 → 아직");
  assert.ok(LA.PUSH_HEARTBEAT_MS <= 50000, "체인 틱(50초)마다 한 번은 나간다");
});

test("틱 기록 — 링 버퍼(최근 50개·24시간), 주행 목록에 섞이지 않는다", () => {
  const now = Date.now();
  let e = [];
  for (let i = 0; i < 60; i++) e = store.logAppend(e, { t: now - (60 - i) * 1000, note: "n" + i }, now);
  assert.equal(e.length, store.LOG_MAX);
  assert.equal(e[0].note, "n10");
  assert.equal(e[e.length - 1].note, "n59");
  e = store.logAppend([{ t: now - 25 * 3600e3, note: "old" }, { t: now - 1000, note: "new" }], { t: now, note: "x" }, now);
  assert.deepEqual(e.map((x) => x.note), ["new", "x"]);
  assert.equal(store.toTrip({ date: "ssl:la:log:t1", events: { tripId: "t1", entries: [] } }), null);
});

test("handler — 틱이 주행별 판단 기록(ssl:la:log:<tripId>)을 남기고, op=log/op=logs 는 시크릿이 있어야 읽힌다", async () => {
  envUp();
  handler._resetLogPrune(Date.now());
  const now = Date.now();
  const pz = fakePusher();
  const logRow = { date: "ssl:la:log:lg", events: { tripId: "lg", entries: [{ t: now - 60000, note: "run", remain: 9, pushed: true, apns: 200 }] }, updated_at: iso(now - 60000) };
  const f = installFetch({ rows: [activeRow("lg", now, { track: baseTrack({ no: "5077" }), last_push_at: iso(now - 120000) }), logRow],
    feed: [train("5077", "왕십리", "1")] });
  try {
    const res = await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(res.body.rows, 1, "기록 행은 주행으로 읽지 않는다");
    const w = f.seen.writes.find((x) => Array.isArray(x.body) && x.body.some((r) => r.date === "ssl:la:log:lg"));
    assert.ok(w, "기록 저장");
    const ent = w.body.find((r) => r.date === "ssl:la:log:lg").events.entries;
    assert.equal(ent.length, 2, "기존 기록 뒤에 붙인다");
    const last = ent[ent.length - 1];
    assert.equal(last.note, "run");
    assert.equal(last.no, "5077");
    assert.equal(last.cur, "왕십리");
    assert.equal(last.sttus, "1");
    assert.equal(last.pushed, true);
    assert.equal(last.apns, 200);
    assert.equal(typeof last.remain, "number");
    assert.equal(last.waiting, false);
    assert.ok(f.seen.urls.some((u) => decodeURIComponent(u).includes("date=not.like.ssl:la:log:*")), "주행 목록 조회는 기록 행을 받아 오지 않는다");

    assert.equal((await call({ query: { op: "log", tripId: "lg" } })).code, 401);
    assert.equal((await call({ query: { op: "logs" } })).code, 401);
    const r1 = await call({ query: { op: "log", tripId: "lg" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(r1.code, 200);
    assert.equal(r1.body.tripId, "lg");
    assert.equal(r1.body.entries[0].note, "run");
    assert.equal((await call({ query: { op: "log" }, headers: { "x-cron-secret": "s3cr3t" } })).code, 400);
    const r2 = await call({ query: { op: "logs", limit: "5" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(r2.code, 200);
    assert.deepEqual(r2.body.trips.map((t) => t.tripId), ["lg"]);
    assert.ok(f.seen.urls.some((u) => u.includes("order=updated_at.desc") && u.includes("limit=5")));
  } finally { f.restore(); pz.restore(); }
});

test("handler — 푸시가 실패하면 last_push_at 을 갱신하지 않는다(다음 틱이 곧바로 다시 보낸다), 기록엔 APNs 코드", async () => {
  envUp();
  handler._resetLogPrune(Date.now());
  const now = Date.now();
  const pz = fakePusher(500);
  const f = installFetch({ rows: [activeRow("pf", now, { track: baseTrack({ no: "5078" }), last_push_at: iso(now - 120000) })],
    feed: [train("5078", "왕십리", "1")] });
  try {
    await call({ query: { op: "tick" }, headers: { "x-cron-secret": "s3cr3t" } });
    assert.equal(pz.sent.length, 1);
    const w = f.seen.writes.find((x) => Array.isArray(x.body) && x.body.some((r) => r.date === "ssl:la:pf"));
    assert.equal(w.body.find((r) => r.date === "ssl:la:pf").events.last_push_at, iso(now - 120000));
    const lw = f.seen.writes.find((x) => Array.isArray(x.body) && x.body.some((r) => r.date === "ssl:la:log:pf"));
    const e = lw.body[0].events.entries.pop();
    assert.equal(e.apns, 500);
    assert.equal(e.pushed, false);
  } finally { f.restore(); pz.restore(); }
});

test("store — 24시간 넘은 기록 행 정리: DELETE 가 무시되면(anon) 작은 삭제 표시로 덮는다", async () => {
  envUp();
  const now = Date.now();
  const real = globalThis.fetch;
  const urls = [], posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    urls.push(`${init.method || "GET"} ${u}`);
    if ((init.method || "GET") === "GET") return jsonRes([
      { date: "ssl:la:log:old", events: { tripId: "old", entries: [] }, updated_at: iso(now - 30 * 3600e3) },
      { date: "ssl:la:log:new", events: { tripId: "new", entries: [] }, updated_at: iso(now - 3600e3) },   /* 필터가 새 것도 돌려줘도 안 건드린다 */
    ]);
    if (init.method === "DELETE") return jsonRes([]);
    posts.push(JSON.parse(init.body));
    return jsonRes([]);
  };
  try {
    const n = await store.pruneLogs(now);
    assert.equal(n, 1);
    assert.ok(urls[0].includes("updated_at=lt.") && urls[0].includes("events->>deleted=is.null"));
    assert.ok(urls.some((u) => u.startsWith("DELETE") && u.includes("ssl:la:log:old") && !u.includes("ssl:la:log:new")));
    assert.deepEqual(posts[0].map((r) => [r.date, r.events.deleted]), [["ssl:la:log:old", true]]);
  } finally { globalThis.fetch = real; }
});
