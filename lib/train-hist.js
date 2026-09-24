/* 노선별 열차 관측 이력 — '운행 대기(주박·장시간 정차)' 판정과 '탄 열차 자동 교체'의 근거.

   실측(2026-09-24, 5호선 하남검단산 방면): 5197 이 상일동 '도착(1)'을 20초마다 새 수신시각으로 47분 동안 보냈다
   (사실상 운행 대기). 그 사이 5055 가 상일동(12:25) → 강일(12:28)로 지나갔고, 사용자는 실제로 5055 를 탔는데
   추적은 5197 에 묶여 '출발 대기'에서 끝나지 않았다.

   이력은 피드가 준 사실만 쌓는다: 열차마다 최근 방문 역 목록
     v = [[역, 첫 수신ms, 마지막 수신ms, 마지막 trainSttus, 새 기록 수], ...]   (오래된 것 → 최신)
   + t(종착역, 정규화) + u(updnLine). 시각은 모두 실제 epoch ms(recptMs: KST → UTC).
   웹(index.html)도 같은 모양·같은 규칙으로 이력을 가진다(서버 이력을 그대로 합칠 수 있게).

   순수 함수만 둔다(네트워크·DB 없음). hist = { trains: { [trainNo]: {t,u,v} }, at } */

const { normStation, recptMs, dedupByTrainNo } = require("./trip-state");

const HIST_KEEP_MS = 60 * 60000;     /* 이만큼 지난 방문은 버린다 */
const HIST_MAX_VISITS = 8;           /* 열차당 최근 방문 역 수 */
const PARKED_MS = 8 * 60000;         /* 같은 역(종착역 아님)에서 새 기록이 이만큼 이어지면 '운행 대기' */
const SWITCH_DWELL_MS = 4 * 60000;   /* 탄 열차가 이만큼 서 있으면 다른 열차로 떠났는지 본다 */
const SWITCH_SINCE_GRACE_MS = 2 * 60000;   /* 추적 시작 이만큼 전까지는 '탈 수 있었던' 열차로 본다 */

const emptyHist = () => ({ trains: {}, at: 0 });

/* 한 기록 반영 — 옛 기록(유령 행)·같은 기록 반복은 무시한다 */
function histAdd(e, stn, r, sttus) {
  const v = e.v, last = v[v.length - 1];
  if (last && r <= last[2]) return;
  if (!last || last[0] !== stn) v.push([stn, r, r, sttus, 1]);
  else { last[2] = r; last[3] = sttus; last[4] = (Number(last[4]) || 1) + 1; }
  if (v.length > HIST_MAX_VISITS) v.splice(0, v.length - HIST_MAX_VISITS);
}

/* 피드 목록 한 번을 이력에 쌓는다. 수신시각이 없으면 now 를 쓴다. */
function histObserve(hist, list, now = Date.now()) {
  if (!hist || !hist.trains) return hist;
  for (const t of dedupByTrainNo(list)) {
    const no = t && t.trainNo != null ? String(t.trainNo) : "";
    const stn = normStation(t && t.statnNm);
    if (!no || !stn) continue;
    const r = recptMs(t.recptnDt);
    const e = hist.trains[no] || (hist.trains[no] = { t: "", u: "", v: [] });
    e.t = normStation(t.statnTnm);
    e.u = String(t.updnLine == null ? "" : t.updnLine);
    histAdd(e, stn, r != null ? r : now, String(t.trainSttus == null ? "" : t.trainSttus));
  }
  hist.at = Math.max(Number(hist.at) || 0, now);
  return hist;
}

/* 오래된 방문·빈 열차 정리 */
function histPrune(hist, now = Date.now()) {
  if (!hist || !hist.trains) return hist;
  const cut = now - HIST_KEEP_MS;
  for (const [no, e] of Object.entries(hist.trains)) {
    const v = Array.isArray(e && e.v) ? e.v.filter((x) => Array.isArray(x) && Number(x[2]) >= cut) : [];
    if (!v.length) delete hist.trains[no]; else e.v = v;
  }
  return hist;
}

/* src 이력을 dst 에 합친다(서버 메모리 ↔ 저장본, 웹 ↔ 서버). 방문을 시각순으로 섞고 같은 역이 이어지면 하나로. */
function histMerge(dst, src) {
  if (!dst || !dst.trains || !src || !src.trains) return dst;
  for (const [no, s] of Object.entries(src.trains)) {
    if (!s || !Array.isArray(s.v) || !s.v.length) continue;
    const d = dst.trains[no];
    if (!d || !Array.isArray(d.v) || !d.v.length) { dst.trains[no] = { t: s.t || "", u: s.u || "", v: s.v.map((x) => x.slice()) }; continue; }
    const all = d.v.concat(s.v).map((x) => x.slice()).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const out = [];
    for (const x of all) {
      const p = out[out.length - 1];
      if (p && p[0] === x[0] && x[1] <= p[2] + 1) {                 /* 같은 방문(겹침) */
        if (x[2] > p[2]) { p[2] = x[2]; p[3] = x[3]; }
        p[4] = Math.max(Number(p[4]) || 1, Number(x[4]) || 1);
      } else if (p && p[0] === x[0]) {                              /* 같은 역이 이어짐 — 한 방문으로 */
        p[2] = Math.max(p[2], x[2]); if (x[2] >= p[2]) p[3] = x[3];
        p[4] = (Number(p[4]) || 1) + (Number(x[4]) || 1);
      } else out.push(x);
    }
    const sLast = s.v[s.v.length - 1][2], dLast = d.v[d.v.length - 1][2];
    if (sLast > dLast) { d.t = s.t || d.t; d.u = s.u || d.u; }
    d.v = out.slice(-HIST_MAX_VISITS);
  }
  dst.at = Math.max(Number(dst.at) || 0, Number(src.at) || 0);
  return dst;
}

/* 운행 대기(주박·장시간 정차): 최신 방문이 종착역이 아닌 역에서 출발(2) 없이 새 기록으로 8분 이상.
   @returns {stn, since, last, durMs} 또는 null */
function parkedInfo(e) {
  if (!e || !Array.isArray(e.v) || !e.v.length) return null;
  const v = e.v[e.v.length - 1];
  if (v[3] === "2" || (Number(v[4]) || 0) < 2) return null;
  if (e.t && v[0] === e.t) return null;                             /* 종착역에 서 있는 건 회차 대기 — 다른 문제 */
  const dur = Number(v[2]) - Number(v[1]);
  return dur >= PARKED_MS ? { stn: v[0], since: Number(v[1]), last: Number(v[2]), durMs: dur } : null;
}
const isParked = (hist, no) => !!(hist && hist.trains && parkedInfo(hist.trains[String(no)]));

/**
 * 탄 열차 자동 교체 판정.
 * 추적 열차가 이번 구간의 X역(출발역 ~ 하차역 직전)에 4분 이상 서 있는데, 그 정차가 시작된 뒤
 * (그리고 추적 시작 2분 전 이후에) 같은 방향 다른 열차가 X에 있다가 구간의 X 뒤쪽 역에서 관측됐다면
 * 사용자는 그 열차를 탔다고 본다 → 그중 X를 가장 먼저 떠난 열차(같으면 지금 X에 가장 가까운 열차).
 *
 * 같은 방향 = 같은 updnLine + 종착역이 구간 안에서 X 이전/같은 역이 아님(pickNextTrain 의 '뒤쪽이면 반대' 규칙)
 *           + 실제로 X → 구간의 X 다음 역으로 움직인 것이 관측됨(이게 방향의 직접 증거)
 *
 * @param hist     노선 이력
 * @param tracked  {no, stations(이번 구간 역, 출발역→하차역), since?(추적 시작 ms)}
 * @param opts     {forward?(no, e, X) → bool}  추가 방향 검사(웹: 노선 그래프)
 * @returns {no, from, stn(X), dep(ms), cur, curIdx, sttus, term, dwellMs} 또는 null
 */
function findSwitch(hist, tracked, opts = {}) {
  if (!hist || !hist.trains || !tracked || tracked.no == null) return null;
  const no = String(tracked.no);
  const te = hist.trains[no];
  if (!te || !Array.isArray(te.v) || !te.v.length) return null;
  const stations = (tracked.stations || []).map(normStation);
  const tv = te.v[te.v.length - 1];
  if (tv[3] === "2" || (Number(tv[4]) || 0) < 2) return null;
  const X = tv[0], xi = stations.indexOf(X);
  if (xi < 0 || xi >= stations.length - 1) return null;           /* 구간 밖이거나 이미 하차역 */
  const dwellMs = Number(tv[2]) - Number(tv[1]);
  if (dwellMs < SWITCH_DWELL_MS) return null;
  const since = Number(tracked.since) || 0;
  const bound = Math.max(Number(tv[1]), since ? since - SWITCH_SINCE_GRACE_MS : 0);

  let best = null;
  for (const [no2, e] of Object.entries(hist.trains)) {
    if (no2 === no || !e || !Array.isArray(e.v) || e.v.length < 2) continue;
    if (String(e.u) !== String(te.u)) continue;                     /* 반대 방향 */
    const ti = e.t ? stations.indexOf(e.t) : -1;
    if (ti >= 0 && ti <= xi) continue;                              /* 종착역이 X 이전/같은 역 → 반대·회차 */
    if (parkedInfo(e)) continue;
    const lv = e.v[e.v.length - 1], curIdx = stations.indexOf(lv[0]);
    if (curIdx <= xi) continue;                                     /* 지금 구간 안에서 X 앞쪽에 있어야 */
    let dep = null;
    for (let k = e.v.length - 2; k >= 0; k--) {
      const a = e.v[k];
      if (a[0] !== X || Number(a[2]) < bound) continue;             /* X 에 있었고, 그게 정차 시작 뒤 */
      const after = e.v.slice(k + 1);
      if (!after.length || stations.indexOf(after[0][0]) <= xi) continue;        /* X 다음 관측이 구간의 X 뒤쪽 역 */
      if (after.some((b) => { const j = stations.indexOf(b[0]); return j >= 0 && j <= xi; })) continue;             /* 되돌아옴 → 다른 열차 흐름 */
      dep = Number(after[0][1]);
      break;
    }
    if (dep == null) continue;
    if (opts.forward && !opts.forward(no2, e, X)) continue;
    const c = { no: no2, from: no, stn: X, dep, cur: lv[0], curIdx, sttus: lv[3], term: e.t, dwellMs };
    if (!best || c.dep < best.dep || (c.dep === best.dep && c.curIdx < best.curIdx)) best = c;
  }
  return best;
}

/* 저장용 압축(JSON) — 그대로 histMerge 의 src 로 쓸 수 있다 */
const histPack = (hist) => ({ trains: (hist && hist.trains) || {}, at: (hist && hist.at) || 0 });
function histUnpack(o) {
  if (!o || typeof o !== "object" || !o.trains || typeof o.trains !== "object") return emptyHist();
  const h = emptyHist();
  for (const [no, e] of Object.entries(o.trains)) {
    if (!e || !Array.isArray(e.v)) continue;
    const v = e.v.filter((x) => Array.isArray(x) && x.length >= 5 && typeof x[0] === "string" && Number.isFinite(+x[1]) && Number.isFinite(+x[2]))
      .map((x) => [x[0], +x[1], +x[2], String(x[3]), +x[4] || 1]);
    if (v.length) h.trains[no] = { t: String(e.t || ""), u: String(e.u == null ? "" : e.u), v };
  }
  h.at = Number(o.at) || 0;
  return h;
}

module.exports = {
  HIST_KEEP_MS, HIST_MAX_VISITS, PARKED_MS, SWITCH_DWELL_MS, SWITCH_SINCE_GRACE_MS,
  emptyHist, histAdd, histObserve, histPrune, histMerge, parkedInfo, isParked, findSwitch, histPack, histUnpack,
};
