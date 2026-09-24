/* 틱 1행 계산 — 네트워크·DB 없이 순수하게 "이 행의 다음 상태와 보낼 푸시"를 정한다.
   api/la.js 가 피드/DB/APNs 를 붙이고, tests/la.test.mjs 는 가짜 피드로 이 함수만 돌린다. */

const { applyTrack, waitingState, pickNextTrain, timeState, findTrain, normStation, AUTO_BOARD_MIN, ROUTE_TRANSFER_MIN, dwellConfirmed } = require("./trip-state");
const { findSwitch, isParked } = require("./train-hist");

/* 내용이 안 바뀌어도 이 간격이 지났으면 보낸다(잠금화면 stale 방지). 체인 틱이 ~50초 간격이라
   60초로 두면 실제로는 ~100초마다 나갔다 → 45초: 틱마다 한 번(최대 ~90초 안에 반드시 한 번) */
const PUSH_HEARTBEAT_MS = 45 * 1000;
/* 환승 대기: 도보(AUTO_BOARD_MIN) + 대기 추정(ROUTE_TRANSFER_MIN - 도보 = 2분) 뒤 탔다고 본다(웹 tripLegReached 의 boardAt 과 같다) */
const XFER_WAIT_EST_MIN = Math.max(0, ROUTE_TRANSFER_MIN - AUTO_BOARD_MIN);
/* 이만큼 지나도 다음 구간 열차를 못 잡으면 시간 기준으로 진행한다(대기 화면에 멈춰 두지 않는다) */
const XFER_FALLBACK_MS = (Math.max(XFER_WAIT_EST_MIN, 3) + 4) * 60000;
/* 시간 기준 도착 예정이 이만큼 지나면 도착으로 끝낸다(overdueEnd 가 +4분에 먼저 끝내는 게 보통 — 그 안전망) */
const TIME_DONE_GRACE_MS = 6 * 60000;
/* 업데이트 푸시의 stale-date: 지금 + max(남은 분, 2) + 3분 — 서버가 살아 있는 동안 위젯이 stale 화면으로 바뀌지 않게 */
const staleSecFor = (remainMin) => (Math.max(Number(remainMin) || 0, 2) + 3) * 60;
const DISMISS_AFTER_SEC = 8;           /* 종료 후 잠금화면에서 사라지기까지 */

const sameState = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/**
 * @param row   ssl_live_trips 한 행 {trip_id, token, env, attrs, state, track, last_push_at}
 * @param feed  (line) => 열차 배열 (이미 받아둔 것)
 * @param now   ms
 * @param histFor (선택) (line) => 노선 관측 이력(lib/train-hist.js) — 운행 대기 판정·탄 열차 자동 교체에 쓴다
 * @returns {tripId, token, env, state, track, changed, push|null, remove, note}
 */
function computeRow(row, feed, now = Date.now(), histFor = null) {
  const out = {
    tripId: row.trip_id, token: row.token, env: row.env || "prod",
    state: row.state || {}, track: row.track || null,
    changed: false, push: null, remove: false, note: "",
  };
  const prev = row.state || {};
  const attrs = row.attrs || {};
  let track = row.track || null;

  /* 아직 탈 열차를 고르지 않았다 — 상태를 그대로 두고 아무것도 보내지 않는다 */
  if (!track || !track.no) { out.note = "no-track"; return out; }

  let state = null;
  let alightFlip = false, doneNow = false, waitingFlip = false, switched = false;
  const histOf = (ln) => (typeof histFor === "function" ? histFor(ln) : null);

  /* ── 환승 대기 중(이전 구간이 끝난 상태) ──
     3분(도보) 뒤부터 다음 구간 열차를 잡는다. 7분이 지나도 못 잡으면 '구간 종료+5분(도보 3 + 대기 2)에 탔다'고 보고 시간 기준으로 진행한다
     (웹 tripTimeProgress 와 같은 생각) — 그래도 그 구간을 달리는 동안은 계속 실제 열차를 찾는다(배차가 길면 늦게 온다). */
  let timeBased = false;
  if (track.legEndedAt) {
    const legs = Array.isArray(track.legs) ? track.legs : [];
    const k = Number(track.legIdx) || 0;
    const nextLeg = legs[k + 1];
    const endedAt = Number(track.legEndedAt);
    const elapsed = now - endedAt;
    const boardAt = endedAt + (AUTO_BOARD_MIN + XFER_WAIT_EST_MIN) * 60000;
    const tb = nextLeg && elapsed >= XFER_FALLBACK_MS ? timeState(track, prev, k + 1, boardAt, now) : null;
    let boarded = null;
    if (nextLeg && elapsed >= AUTO_BOARD_MIN * 60000 && (!tb || tb.onBaseLeg)) {
      const h = histOf(nextLeg.line);
      boarded = pickNextTrain(track, feed(nextLeg.line), now, { skip: (no) => isParked(h, no) });   /* 운행 대기 열차는 태우지 않는다 */
    }
    if (boarded) {
      track = boarded;                                   /* 다음 구간 열차를 잡았다 → 바로 주행 계산으로 */
      out.note = tb ? "auto-board-late" : "auto-board";
    } else if (tb) {
      timeBased = true;
      track = Object.assign({}, track, { timeBasedAt: Number(track.timeBasedAt) || now, assumedBoardAt: boardAt });
      state = tb.state;
      alightFlip = !!state.alight && !prev.alight;   /* 시간 기준이어도 웹(tripTimeProgress)처럼 하차 안내 */
      out.note = "time-based";
      if (tb.done && now - tb.arrivalMs >= TIME_DONE_GRACE_MS) { doneNow = true; out.note = "time-based-done"; }
    } else {
      state = waitingState(track, prev, endedAt, now);
      waitingFlip = !prev.waiting;
      out.note = out.note || (nextLeg ? "waiting" : "waiting-nonext");
      /* 다음 구간이 없는 이상한 행 — 남은 시간이 지나고도 한참이면 끝낸다(영원히 '대기 중'으로 두지 않는다) */
      if (!nextLeg && now - endedAt >= (Number(track.laterMin) || 0) * 60000 + TIME_DONE_GRACE_MS) { doneNow = true; out.note = "waiting-done"; }
    }
  }
  /* ── 탄 열차 자동 교체 ──
     추적 열차가 구간 안 X역에 4분 넘게 서 있는 동안 같은 방향 다른 열차가 X를 떠나 구간 앞쪽에서 잡혔다
     → 사용자는 그 열차에 타 있다(서 있는 열차는 운행 대기). 웹(index.html tripAutoSwitch)과 같은 규칙. */
  if (!state && !track.legEndedAt) {
    const sw = findSwitch(histOf(track.line), {
      no: track.no, stations: track.stations, since: Number(track.since) || Number(track.boardedAt) || 0,
    });
    if (sw) {
      const nt = findTrain(feed(track.line), sw.no, track.line);
      track = Object.assign({}, track, {
        no: sw.no, dest: (nt && nt.statnTnm) || sw.term || track.dest || "",
        dwell: null, approach: [], switchedFrom: String(track.no), switchedAt: now, switchedAtStn: sw.stn,
      });
      switched = true;
      out.note = "switch";
    }
  }

  /* ── 주행 계산 ── */
  if (!state) {
    /* 노선별 피드에서 노선까지 맞는 열차만 — 열차번호는 노선끼리 겹친다(5호선 5073 ↔ 경의중앙선 5073) */
    const train = findTrain(feed(track.line), track.no, track.line);
    if (!train) {
      /* 피드에 없으면 판단하지 않는다(Swift 와 같음). 하트비트만 나간다.
         단, 출발 대기(waiting — 아직 안 탔음) 중에 사라진 채 7분이 지나면, 마지막으로 보인 'N분 후 출발' 뒤에 탔다고 보고
         시간 기준으로 진행한다('1분 후 출발'에 멈춰 두지 않는다). 다시 보이면 곧바로 실제 위치로 돌아간다. */
      const lostAt = Number(track.lostAt) || now;
      track = Object.assign({}, track, { lostAt });
      out.note = out.note || "train-not-in-feed";
      const tbAt = Number(track.assumedBoardAt) ||
        (prev.waiting && now - lostAt >= XFER_FALLBACK_MS ? lostAt + Math.max(0, Number(prev.waitMin) || 0) * 60000 : 0);
      const tb = tbAt ? timeState(track, prev, Number(track.legIdx) || 0, tbAt, now) : null;
      if (tb) {
        timeBased = true;
        track = Object.assign({}, track, { assumedBoardAt: tbAt });
        state = tb.state;
        alightFlip = !!state.alight && !prev.alight;
        out.note = "time-based-lost";
        if (tb.done && now - tb.arrivalMs >= TIME_DONE_GRACE_MS) { doneNow = true; out.note = "time-based-done"; }
      } else {
        state = Object.assign({}, prev);
      }
    } else {
      if (track.lostAt || track.assumedBoardAt) {
        track = Object.assign({}, track);
        delete track.lostAt; delete track.assumedBoardAt;
      }
      out.diag = { cur: normStation(train.statnNm), sttus: String(train.trainSttus == null ? "" : train.trainSttus) };
      const res = applyTrack(track, train, prev, now);
      if (!res) {
        state = Object.assign({}, prev);
        out.note = out.note || "unknown-position";
      } else {
        state = res.state;
        /* 장시간 정차 추적값은 track 에 이어 둔다(다음 틱이 같은 역 '도착' 기록이 이어지는지 본다) */
        track = Object.assign({}, track, { dwell: res.dwell || null });
        alightFlip = !!res.alight && !prev.alight;
        doneNow = !!res.done;
        if (res.legEnded) {
          /* 환승역 도착 — 구간 종료를 표시하고 곧바로 대기 상태로 전환한다 */
          track = Object.assign({}, track, { legEndedAt: now });
          state = waitingState(track, state, now, now);
          waitingFlip = !prev.waiting;
          out.note = out.note || "leg-end";
        } else {
          out.note = out.note || (res.dwelling ? "dwell" : res.phase === "approach" ? "approach" : "run");
        }
      }
    }
  }

  out.state = state;
  out.track = track;
  out.changed = !sameState(state, prev) || switched;
  out.switched = switched;
  out.timeBased = timeBased;

  const lastPush = row.last_push_at ? Date.parse(row.last_push_at) : 0;
  const stale = !lastPush || now - lastPush >= PUSH_HEARTBEAT_MS;

  if (doneNow) {
    state = Object.assign({}, state, { done: true, remainMin: 0, alight: false, waiting: false, waitMin: 0 });
    out.state = state;
    out.push = {
      event: "end",
      priority: 10,
      dismissalSec: Math.floor(now / 1000) + DISMISS_AFTER_SEC,
      staleSec: 300,
      alert: { title: "목적지 도착", body: `${attrs.to || state.legTo || "목적지"}에 도착했습니다` },
    };
    out.remove = true;
    return out;
  }

  if (out.changed || stale) {
    out.push = {
      event: "update",
      priority: (alightFlip || waitingFlip || switched) ? 10 : 5,
      dismissalSec: null,
      staleSec: staleSecFor(state.remainMin),
      alert: alightFlip ? { title: "곧 내리세요", body: `다음 역 ${state.legTo || ""}에서 내리세요` } : null,
    };
  }
  return out;
}

/* ── 매달린 라이브 액티비티 정리 ─────────────────────────────────────────────
   서버가 멈췄거나(체인 단절)·앱이 죽었거나·피드에서 열차가 사라져도
   잠금화면에 "오후 9:32 도착 예정" 이 몇 시간씩 남지 않도록 한다. */

const OVERDUE_GRACE_MS = 4 * 60 * 1000;     /* 도착 예정(endEpoch) + 이만큼 지났고, 이만큼 진척이 없으면 도착으로 본다 */
const PAUSED_STALE_MS = 30 * 60 * 1000;     /* paused 행을 앱이 이만큼 안 건드렸으면 지운다(푸시 없이 — 앱 소유) */
const OVERDUE_DISMISS_SEC = 60;

const ms = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };

/* 열차가 '움직였는가'를 보는 열쇠 — arriveAt/endEpoch 처럼 매 틱 now 로 다시 계산되는 값은 뺀다 */
function progressKey(state, track) {
  const s = state || {}, t = track || {};
  return JSON.stringify([t.no || "", Number(t.legIdx) || 0, t.legEndedAt ? 1 : 0,
    s.nextStation || "", Number(s.remainMin) || 0, !!s.waiting, !!s.alight, s.legTo || "", !!s.done]);
}

/* 마지막 진척 시각 — 예전 행(last_progress_at 없음)은 마지막 피드 반영/저장 시각으로 본다 */
const lastProgressAt = (row) => ms(row.last_progress_at) || ms(row.last_feed_at) || ms(row.updated_at);

/**
 * 피드를 보기 전에 판정하는 정리 규칙.
 * @returns null(정리 대상 아님) 또는 computeRow 와 같은 모양의 결과 {tripId, token, env, state, push, remove, note}
 *   - paused 행: 앱이 30분 넘게 안 건드렸거나 만료 → 푸시 없이 삭제
 *   - 만료(expires_at 지남): event:"end" + 마지막 상태(done:false) + 즉시 dismiss → 삭제
 */
function sweepRow(row, now = Date.now()) {
  if (!row || row.deleted) return null;   /* 소프트 삭제된 행은 없는 것 */
  const base = { tripId: row.trip_id, token: row.token, env: row.env || "prod", state: row.state || {}, track: row.track || null,
    changed: false, push: null, remove: true, note: "" };
  const exp = ms(row.expires_at);
  const expired = !!exp && now > exp;
  if (row.paused) {
    const upd = ms(row.updated_at);
    if (expired || !upd || now - upd > PAUSED_STALE_MS) return Object.assign(base, { note: "paused-stale" });
    return null;
  }
  if (!expired) return null;
  if (!row.token) return Object.assign(base, { note: "expired-notoken" });
  return Object.assign(base, {
    note: "expired",
    state: Object.assign({}, row.state || {}, { done: false }),
    push: { event: "end", priority: 10, dismissalSec: Math.floor(now / 1000), staleSec: 60, alert: null },
  });
}

/**
 * 도착 예정이 한참 지났는데 열차가 진척이 없다 → 도착으로 보고 끝낸다.
 * computeRow 결과(x)를 받아 필요하면 end 푸시로 바꿔 돌려준다(x 를 고치지 않고 새 객체).
 * 열차가 피드에 잡혀 있으면 endEpoch 가 매 틱 now 뒤로 밀리므로 걸리지 않는다 —
 * 피드에서 사라졌거나(state 유지) 서버가 한동안 멈췄던 행만 걸린다.
 */
function overdueEnd(row, x, now = Date.now()) {
  if (!x || (x.push && x.push.event === "end") || x.remove) return null;
  /* 피드가 열차를 역에 '서 있음'으로 계속 확인해 주는 중(출발 대기) — 목적지 도착이 아니다 */
  const dw = x.track && x.track.dwell;
  if (dwellConfirmed(dw) && now - (Number(dw.seen) || 0) < OVERDUE_GRACE_MS) return null;
  const st = x.state || {};
  const endEpoch = Number(st.endEpoch) || 0;
  if (!endEpoch || now <= endEpoch + OVERDUE_GRACE_MS) return null;
  if (progressKey(st, x.track) !== progressKey(row.state, row.track)) return null;   /* 이번 틱에 움직였다 */
  if (now - lastProgressAt(row) < OVERDUE_GRACE_MS) return null;
  const attrs = row.attrs || {};
  return Object.assign({}, x, {
    note: "overdue",
    changed: true,
    remove: true,
    state: Object.assign({}, st, { done: true, remainMin: 0, alight: false, waiting: false, waitMin: 0 }),
    push: {
      event: "end", priority: 10,
      dismissalSec: Math.floor(now / 1000) + OVERDUE_DISMISS_SEC, staleSec: 300,
      alert: { title: "목적지 도착", body: `${attrs.to || st.legTo || "목적지"}에 도착했습니다` },
    },
  });
}

module.exports = {
  computeRow, sameState, PUSH_HEARTBEAT_MS, DISMISS_AFTER_SEC, staleSecFor,
  XFER_FALLBACK_MS, XFER_WAIT_EST_MIN, TIME_DONE_GRACE_MS,
  sweepRow, overdueEnd, progressKey, lastProgressAt, OVERDUE_GRACE_MS, PAUSED_STALE_MS, OVERDUE_DISMISS_SEC,
};
