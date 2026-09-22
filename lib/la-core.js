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

module.exports = { computeRow, sameState, PUSH_HEARTBEAT_MS, DISMISS_AFTER_SEC };
