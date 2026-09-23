/* 틱 1행 계산 — 네트워크·DB 없이 순수하게 "이 행의 다음 상태와 보낼 푸시"를 정한다.
   api/la.js 가 피드/DB/APNs 를 붙이고, tests/la.test.mjs 는 가짜 피드로 이 함수만 돌린다. */

const { applyTrack, waitingState, pickNextTrain, findTrain, AUTO_BOARD_MIN } = require("./trip-state");

const PUSH_HEARTBEAT_MS = 60 * 1000;   /* 내용이 안 바뀌어도 이 간격마다 한 번은 보낸다(잠금화면 stale 방지) */
const DISMISS_AFTER_SEC = 8;           /* 종료 후 잠금화면에서 사라지기까지 */

const sameState = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/**
 * @param row   ssl_live_trips 한 행 {trip_id, token, env, attrs, state, track, last_push_at}
 * @param feed  (line) => 열차 배열 (이미 받아둔 것)
 * @param now   ms
 * @returns {tripId, token, env, state, track, changed, push|null, remove, note}
 */
function computeRow(row, feed, now = Date.now()) {
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
  let alightFlip = false, doneNow = false, waitingFlip = false;

  /* ── 환승 대기 중(이전 구간이 끝난 상태) ── */
  if (track.legEndedAt) {
    const legs = Array.isArray(track.legs) ? track.legs : [];
    const nextLeg = legs[(Number(track.legIdx) || 0) + 1];
    const elapsed = now - Number(track.legEndedAt);
    let boarded = null;
    if (nextLeg && elapsed >= AUTO_BOARD_MIN * 60000) {
      boarded = pickNextTrain(track, feed(nextLeg.line), now);
    }
    if (boarded) {
      track = boarded;                                   /* 다음 구간 열차를 잡았다 → 바로 주행 계산으로 */
      out.note = "auto-board";
    } else {
      state = waitingState(track, prev, Number(track.legEndedAt), now);
      waitingFlip = !prev.waiting;
      out.note = out.note || (nextLeg ? "waiting" : "waiting-nonext");
    }
  }

  /* ── 주행 계산 ── */
  if (!state) {
    const train = findTrain(feed(track.line), track.no);
    if (!train) {
      out.track = track;
      out.note = out.note || "train-not-in-feed";
      /* 피드에 없으면 판단하지 않는다(Swift 와 같음). 하트비트만 나간다. */
      state = Object.assign({}, prev);
    } else {
      const res = applyTrack(track, train, prev, now);
      if (!res) {
        state = Object.assign({}, prev);
        out.note = out.note || "unknown-position";
      } else {
        state = res.state;
        alightFlip = !!res.alight && !prev.alight;
        doneNow = !!res.done;
        if (res.legEnded) {
          /* 환승역 도착 — 구간 종료를 표시하고 곧바로 대기 상태로 전환한다 */
          track = Object.assign({}, track, { legEndedAt: now });
          state = waitingState(track, state, now, now);
          waitingFlip = !prev.waiting;
          out.note = out.note || "leg-end";
        } else {
          out.note = out.note || (res.phase === "approach" ? "approach" : "run");
        }
      }
    }
  }

  out.state = state;
  out.track = track;
  out.changed = !sameState(state, prev);

  const lastPush = row.last_push_at ? Date.parse(row.last_push_at) : 0;
  const stale = !lastPush || now - lastPush >= PUSH_HEARTBEAT_MS;

  if (doneNow) {
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
      priority: (alightFlip || waitingFlip) ? 10 : 5,
      dismissalSec: null,
      staleSec: Math.max(1, Number(state.remainMin) || 1) * 60 + 120,
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
  computeRow, sameState, PUSH_HEARTBEAT_MS, DISMISS_AFTER_SEC,
  sweepRow, overdueEnd, progressKey, lastProgressAt, OVERDUE_GRACE_MS, PAUSED_STALE_MS, OVERDUE_DISMISS_SEC,
};
