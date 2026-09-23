/* 제보하기 API 테스트 — 저장소(Supabase)는 가짜로 바꿔 끼운다(네트워크 없음).
   실행:  node --test tests/feedback.test.mjs */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("../lib/supabase.js");
const FB = require("../api/feedback.js");
const { cronSecret } = require("../api/la.js");

/* 저장 호출 가로채기 */
const calls = { upsert: [], select: [] };
let failUpsert = false;
let selectRows = [];
store.sbUpsert = async (table, row, onConflict) => {
  if (failUpsert) throw new Error("supabase 500 boom");
  calls.upsert.push({ table, row, onConflict });
  return [row];
};
store.sbSelect = async (table, query) => { calls.select.push({ table, query }); return selectRows; };

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const req = (over = {}) => Object.assign({ method: "POST", query: {}, headers: { "x-forwarded-for": "203.0.113.7" } }, over);
async function call(over) { const res = mockRes(); await FB(req(over), res); return res; }

const sample = (over = {}) => Object.assign({
  kind: "trip",
  category: ["position", "eta"],
  message: "  열차가 한 정거장 늦게 표시됐어요  ",
  trip: { from: "상일동", to: "내방", legs: [{ line: "5호선", from: "상일동", to: "군자" }, { line: "7호선", from: "군자", to: "내방" }],
          elapsedMin: 41, plannedMin: 43, transfers: 1, arrivedAt: "오후 9:32" },
  app: { version: "1.0", build: "9", os: "26.0", device: "iPhone17,1" },
}, over);

test.beforeEach(() => { FB._resetRate(); calls.upsert.length = 0; calls.select.length = 0; failUpsert = false; selectRows = []; });

test("validate — 정상 본문을 정리한다", () => {
  const v = FB.validate(sample({ category: ["eta", "position", "eta"] }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.category, ["eta", "position"]);
  assert.equal(v.value.message, "열차가 한 정거장 늦게 표시됐어요");
  assert.equal(v.value.trip.legs.length, 2);
  assert.equal(v.value.trip.elapsedMin, 41);
  assert.equal(v.value.app.device, "iPhone17,1");
});

test("validate — 모르는 항목·kind·빈 제보는 거절", () => {
  assert.equal(FB.validate(sample({ category: ["position", "hack"] })).ok, false);
  assert.equal(FB.validate(sample({ kind: "other" })).ok, false);
  assert.equal(FB.validate(sample({ category: [], message: "   " })).ok, false);
  assert.equal(FB.validate(sample({ message: 42 })).ok, false);
  assert.equal(FB.validate(null).ok, false);
  assert.equal(FB.validate([]).ok, false);
  /* 글만 있어도, 항목만 있어도 된다 */
  assert.equal(FB.validate(sample({ category: [] })).ok, true);
  assert.equal(FB.validate(sample({ message: "" })).ok, true);
  /* 문자열 하나도 받아 준다 */
  assert.deepEqual(FB.validate(sample({ category: "other" })).value.category, ["other"]);
});

test("validate — 제어 문자 제거·1000자 자르기·줄바꿈 유지", () => {
  const v = FB.validate(sample({ message: "a\u0000b\u0007c\r\nd\u2028\u202945" + "가".repeat(2000) }));
  assert.equal(v.ok, true);
  assert.ok(!/[\u0000-\u0009\u000B-\u001F\u2028\u2029]/.test(v.value.message));
  assert.ok(v.value.message.startsWith("abc\nd45"));
  assert.equal(Array.from(v.value.message).length, 1000);
  const t = FB.validate(sample({ trip: { from: "상\u0001일동", to: "x".repeat(500), legs: new Array(40).fill({ line: "5호선", from: "a", to: "b" }), elapsedMin: "abc" } }));
  assert.equal(t.value.trip.from, "상일동");
  assert.equal(t.value.trip.to.length, 60);
  assert.equal(t.value.trip.legs.length, 12);
  assert.equal(t.value.trip.elapsedMin, null);
});

test("POST — 저장하고 {ok, id} 를 돌려준다(원래 IP 는 저장 안 함)", async () => {
  const res = await call({ body: sample() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.id, /^[a-z0-9]{6}$/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(calls.upsert.length, 1);
  const { table, row, onConflict } = calls.upsert[0];
  assert.equal(table, "sf_cache");
  assert.equal(onConflict, "date");
  assert.match(row.date, /^ssl:fb:\d{4}-\d{2}-\d{2}T[\d:.]+Z:[a-z0-9]{6}$/);
  assert.ok(row.date.endsWith(":" + res.body.id));
  assert.equal(row.events.ip_hash, FB.ipHash("203.0.113.7"));
  assert.equal(row.events.ip_hash.length, 12);
  assert.ok(row.events.received_at);
  assert.ok(!JSON.stringify(row).includes("203.0.113.7"));
  assert.deepEqual(row.events.category, ["position", "eta"]);
});

test("POST — 문자열 본문도 받는다, 깨진 JSON 은 400", async () => {
  assert.equal((await call({ body: JSON.stringify(sample()) })).statusCode, 200);
  assert.equal((await call({ body: "{nope" })).statusCode, 400);
  assert.equal((await call({ body: sample({ category: ["bogus"] }) })).statusCode, 400);
});

test("POST — 8KB 넘는 본문은 413", async () => {
  const big = sample({ message: "x".repeat(9000) });
  assert.equal((await call({ body: big })).statusCode, 413);
  assert.equal((await call({ body: sample(), headers: { "content-length": "9000" } })).statusCode, 413);
  assert.equal(calls.upsert.length, 0);
});

test("POST — IP 당 10분에 5회까지, 6번째는 429 · 다른 IP 는 영향 없음", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call({ body: sample() })).statusCode, 200);
  const r6 = await call({ body: sample() });
  assert.equal(r6.statusCode, 429);
  assert.ok(r6.headers["retry-after"]);
  assert.equal((await call({ body: sample(), headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } })).statusCode, 200);
  assert.equal(calls.upsert.length, 6);
});

test("rateOk — 창이 지나면 다시 허용", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(FB.rateOk("k", t0 + i), true);
  assert.equal(FB.rateOk("k", t0 + 10), false);
  assert.equal(FB.rateOk("k", t0 + 10 * 60 * 1000 + 5), true);
});

test("POST — 저장 실패는 500(내부 메시지 노출 없음)", async () => {
  failUpsert = true;
  const res = await call({ body: sample() });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "server");
});

test("OPTIONS 204 · GET(인증 없는) 405", async () => {
  assert.equal((await call({ method: "OPTIONS" })).statusCode, 204);
  assert.equal((await call({ method: "GET" })).statusCode, 405);
});

test("GET op=list — 비밀 헤더 필요, 최근 순 목록", async () => {
  const q = { op: "list", limit: "50" };
  assert.equal((await call({ method: "GET", query: q })).statusCode, 401);
  assert.equal((await call({ method: "GET", query: q, headers: { "x-cron-secret": "wrong" } })).statusCode, 401);
  selectRows = [
    { date: "ssl:fb:2026-09-23T12:00:00.000Z:abc123", events: { id: "abc123", category: ["eta"], message: "hi" } },
    { date: "ssl:fb:2026-09-23T11:00:00.000Z:zzz999", events: { deleted: true } },
  ];
  const res = await call({ method: "GET", query: q, headers: { "x-cron-secret": cronSecret() } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.items[0].key, "ssl:fb:2026-09-23T12:00:00.000Z:abc123");
  assert.match(calls.select[0].query, /order=date\.desc&limit=50$/);
  assert.match(calls.select[0].query, /^date=like\.ssl%3Afb%3A\*/);
});
