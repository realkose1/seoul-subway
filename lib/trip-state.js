/* 주행 추적 상태 머신 — iOS 앱이 백그라운드에서 돌리던 로직(ContentView.swift 의 bgPoll/bgApply)을
   서버로 옮긴 것. UIBackgroundModes: location 없이 APNs 푸시로 라이브 액티비티를 갱신하기 위함이다.

   순수 함수만 둔다(네트워크·DB 없음) → tests/la.test.mjs 에서 가짜 피드로 그대로 돌릴 수 있다.

   Swift 원본과의 대응:
     normStation      = ContentView.normStation
     applyTrack()     = bgApply(track:cur:sttus:)
     ContentState 키  = TripActivity/TripAttributes.swift 의 ContentState 프로퍼티명과 1:1 */

const ROUTE_HOP_MIN = 2;          /* 정거장 간 평균 소요(분) — index.html 과 같은 값 */
const ROUTE_TRANSFER_MIN = 5;     /* 환승 1회 평균(도보+대기, 분) */
const EXPRESS_HOP_MIN = 1.4;      /* 급행은 역당 더 빠름 */
const AUTO_BOARD_MIN = 3;         /* 환승 도보 추정 — 이 전에 떠나는 열차는 탈 수 없다고 본다(index.html TRIP_AUTO_BOARD_MS) */

/* 노선색 — index.html 의 LINES[*].color 와 같은 값(환승 구간으로 넘어갈 때 서버가 색을 채워야 한다) */
const LINE_COLORS = {
  "1호선": "#0052A4", "2호선": "#00A84D", "3호선": "#EF7C1C", "4호선": "#00A5DE", "5호선": "#996CAC",
  "6호선": "#CD7C2F", "7호선": "#747F00", "8호선": "#E6186C", "9호선": "#BDB092",
  "수인분당선": "#FABE00", "신분당선": "#D4003B", "경강선": "#003DA5", "경의중앙선": "#77C4A3",
  "공항철도": "#0090D2", "경춘선": "#178C72", "우이신설선": "#B7C452", "서해선": "#8FC31F", "신림선": "#6789CA",
};
const lineColor = (line) => LINE_COLORS[line] || "#8A8F98";

/* 역명 정규화: 피드의 "천호역", "천호(풍납토성)" 등을 경로 역 목록과 맞춘다.
   Swift 원본과 같되, 괄호를 떼어낸 뒤 한 번 더 trim 한다("천호 (풍납토성)" 같은 표기 대응). */
function normStation(s) {
  let n = String(s == null ? "" : s).trim();
  const i = n.indexOf("(");
  if (i >= 0) n = n.slice(0, i).trim();
  if (n.length > 1 && n.endsWith("역")) n = n.slice(0, -1);
  return n;
}

/* Swift 의 Double.rounded() = 0.5에서 0에서 먼 쪽으로. JS Math.round 는 +∞ 쪽이라 음수에서만 다르다. */
const rnd = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

/* "오후 1:36" (ko_KR "a h:mm", Asia/Seoul) — Swift clockAfter(min:) 과 같은 표기 */
function clockAfter(min, now = Date.now()) {
  const d = new Date(now + min * 60000);
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit", hour12: true })
    .format(d).replace(/ | /g, " ").trim();
}

/* trainSttus: "0"=진입(접근), "1"=도착, "2"=출발, "3"=전역출발 — Swift 와 같은 보정치 */
const sttusExtra = (sttus) => (sttus === "0" ? 0.5 : sttus === "2" ? -0.4 : 0);

/* legs[k] 이후로 남는 시간(분) — index.html 의 ROUTE_TRANSFER_MIN + tripMinFromLeg(k+1) 와 같다 */
function laterMinFrom(legs, k) {
  if (!Array.isArray(legs) || k >= legs.length - 1) return 0;
  let m = ROUTE_TRANSFER_MIN;
  for (let i = k + 1; i < legs.length; i++) m += (Number(legs[i].min) || 0) + (i < legs.length - 1 ? ROUTE_TRANSFER_MIN : 0);
  return m;
}

/* 피드에서 이 열차 찾기 */
function findTrain(list, no) {
  if (!Array.isArray(list)) return null;
  const want = String(no);
  return list.find((t) => String(t.trainNo == null ? "" : t.trainNo) === want) || null;
}

/**
 * 한 열차의 현재 위치로 새 ContentState 를 만든다. (bgApply 이식)
 *
 * @param track  {no,line,legIdx,stations[],legTo,isLast,laterMin,dest,legs[],stops[]|null,approach[]}
 * @param train  피드 항목 {statnNm, trainSttus, statnTnm, updnLine} 또는 null
 * @param prev   직전 ContentState (없으면 {})
 * @returns null (판단 불가 — 상태 유지) 또는
 *          { state, phase:"approach"|"run", atEnd, alight, done, legEnded }
 */
function applyTrack(track, train, prev, now = Date.now()) {
  if (!track || !train) return null;
  const stations = Array.isArray(track.stations) ? track.stations : [];
  if (!stations.length) return null;

  const cur = normStation(train.statnNm);
  const sttus = String(train.trainSttus == null ? "" : train.trainSttus);
  const stationsNorm = stations.map(normStation);
  const approach = Array.isArray(track.approach) ? track.approach : [];
  const hasStops = track.stops != null;                 /* Swift: tk.stops != nil (빈 배열도 급행 취급) */
  const hopMin = hasStops ? EXPRESS_HOP_MIN : ROUTE_HOP_MIN;
  const laterMin = Number(track.laterMin) || 0;
  const base = Object.assign({}, prev || {});

  /* ── 접근 구간: 아직 출발역에 오지 않음 → '대기 중 · N분 후 출발' ── */
  if (!stationsNorm.includes(cur)) {
    const ai = approach.findIndex((s) => normStation(s) === cur);
    if (ai < 0) return null;                            /* 이 구간과 무관한 위치 → 상태 유지 */
    const stopsToOrigin = Math.max(0, approach.length - ai + sttusExtra(sttus));
    const waitMin = stopsToOrigin * ROUTE_HOP_MIN + 0.5;
    const legMin = Math.max(0, stations.length - 1) * hopMin;
    const remain = rnd(waitMin + legMin + laterMin);
    const state = Object.assign(base, {
      remainMin: remain,
      nextStation: stations[0] || base.nextStation || "",
      alight: false,
      waiting: true,
      waitMin: Math.max(1, rnd(waitMin)),
      arriveAt: clockAfter(remain, now),
      endEpoch: now + remain * 60000,
    });
    return { state, phase: "approach", atEnd: false, alight: false, done: !!state.done, legEnded: false };
  }

  /* ── 주행 구간 ── */
  const idx = stationsNorm.indexOf(cur);
  const last = stations.length - 1;
  const atEnd = idx >= last && sttus !== "0";
  let nextIdx = sttus === "0" ? idx : Math.min(last, idx + 1);
  /* 급행: 다음 '정차역'은 통과역을 건너뛴 첫 정차역 */
  if (Array.isArray(track.stops) && track.stops.length) {
    const stopSet = new Set(track.stops.map(normStation));
    let j = nextIdx;
    while (j < last && !stopSet.has(stationsNorm[j])) j++;
    nextIdx = j;
  }
  const legRemain = atEnd ? 0 : Math.max(0, last - idx + sttusExtra(sttus)) * hopMin;
  const remain = rnd(legRemain + laterMin);
  const alight = !atEnd && nextIdx >= last;
  const done = !!track.isLast && atEnd;

  const state = Object.assign(base, {
    remainMin: remain,
    nextStation: atEnd ? track.legTo : stations[nextIdx],
    alight,
    waiting: false,
    waitMin: 0,
    arriveAt: clockAfter(remain, now),
    endEpoch: now + remain * 60000,
    done,
  });
  return { state, phase: "run", atEnd, alight, done, legEnded: atEnd && !done };
}

/**
 * 구간이 끝났는데 마지막이 아닐 때(환승) — 다음 열차를 고를 때까지의 대기 상태.
 * Swift 에선 이 시점에 하차 알림만 예약하고 추적을 멈췄다(앱을 열어야 다음 열차를 골랐다).
 * 서버는 대신 '대기 중'을 계속 갱신하고, 3분 뒤 다음 구간 열차를 자동으로 잡는다.
 */
function waitingState(track, prev, legEndedAt, now = Date.now()) {
  const legs = Array.isArray(track.legs) ? track.legs : [];
  const k = Number(track.legIdx) || 0;
  const nextLeg = legs[k + 1] || {};
  const elapsedMin = Math.max(0, (now - legEndedAt) / 60000);
  const waitMin = Math.max(1, Math.ceil(AUTO_BOARD_MIN - elapsedMin));
  const remain = Math.max(1, rnd((Number(track.laterMin) || 0) - elapsedMin));
  const line = nextLeg.line || track.line;
  return Object.assign({}, prev || {}, {
    remainMin: remain,
    arriveAt: clockAfter(remain, now),
    line,
    colorHex: lineColor(line),
    nextStation: track.legTo || "",      /* 지금 서 있는 환승역 = 다음 구간의 승차역 */
    legTo: nextLeg.to || track.legTo || "",
    isLast: k + 1 >= legs.length - 1,
    done: false,
    waiting: true,
    waitMin,
    alight: false,
    endEpoch: now + remain * 60000,
  });
}

/**
 * 환승역에서 다음 구간 열차 자동 승차.
 * 조건: 환승역에 있거나(statnNm == 환승역) 진입 중(trainSttus "0")이고, 방향이 다음 구간과 맞을 것.
 * 방향은 '다음 구간의 역 순서'로 판정한다 — 종착역(statnTnm)이 역 목록 안에서 환승역보다 뒤에 있으면 같은 방향.
 * 판단할 수 없으면(다음 구간 역 목록이 없거나 종착역이 목록 밖) 추측하지 않고 대기를 유지한다.
 *
 * @returns 새 track (legIdx+1) 또는 null
 */
function pickNextTrain(track, list, now = Date.now()) {
  const legs = Array.isArray(track.legs) ? track.legs : [];
  const k = Number(track.legIdx) || 0;
  const nextLeg = legs[k + 1];
  if (!nextLeg || !Array.isArray(nextLeg.stations) || nextLeg.stations.length < 2) return null;

  const nStations = nextLeg.stations;
  const nNorm = nStations.map(normStation);
  const xfer = normStation(track.legTo);
  const xi = nNorm.indexOf(xfer);
  if (xi < 0 || xi >= nNorm.length - 1) return null;   /* 환승역이 다음 구간 목록에 없음 → 추측하지 않음 */

  for (const t of (Array.isArray(list) ? list : [])) {
    const at = normStation(t.statnNm);
    const sttus = String(t.trainSttus == null ? "" : t.trainSttus);
    if (at !== xfer) continue;                          /* 환승역에 있음(진입 "0" 포함) */
    const term = normStation(t.statnTnm);
    const ti = nNorm.indexOf(term);
    if (ti < 0 || ti <= xi) continue;                   /* 종착역이 목록 밖이거나 뒤쪽 → 방향 불확실/반대 */
    return {
      no: String(t.trainNo),
      line: nextLeg.line,
      legIdx: k + 1,
      stations: nStations.slice(xi),                    /* 환승역부터 이번 구간 종료역까지 */
      legTo: nextLeg.to,
      isLast: k + 1 === legs.length - 1,
      laterMin: laterMinFrom(legs, k + 1),
      dest: t.statnTnm || "",
      legs,
      stops: null,                                      /* 급행 정차 목록은 웹만 계산할 수 있다 → 일반 열차로 본다 */
      approach: [],
      boardedAt: now,
      _sttus: sttus,
    };
  }
  return null;
}

module.exports = {
  ROUTE_HOP_MIN, ROUTE_TRANSFER_MIN, EXPRESS_HOP_MIN, AUTO_BOARD_MIN,
  LINE_COLORS, lineColor, normStation, clockAfter, rnd, sttusExtra,
  laterMinFrom, findTrain, applyTrack, waitingState, pickNextTrain,
};
