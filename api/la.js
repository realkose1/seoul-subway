/* 라이브 액티비티(주행 안내) 서버 — APNs 푸시로 잠금화면을 갱신한다.
   UIBackgroundModes: location(위치 keep-alive)을 대신하는 정식 방식:
     앱이 pushType: .token 으로 액티비티를 시작 → 토큰+주행 정보를 여기로 보냄(op=register)
     → 서버가 열차를 따라가며 ActivityKit 업데이트를 푸시.

   스케줄러는 **자기 호출 체인**이다(Vercel Hobby 는 분 단위 크론이 없다):
     register/update/end/kick 이 (잠금이 비었고 할 일이 있으면) 체인을 띄우고 → 틱이 일을 마친 뒤
     호출 시작 기준 ~50초에 자기 자신(op=tick&chain=1)을 부른다. 활성 주행이 없으면 체인이 멈추고
     잠금이 풀린다. 응답 후 함수가 얼어 다음 호출이 안 나가던 문제 때문에:
       - 체인 틱은 잠금만 확인하고 곧바로 202 를 돌려준 뒤, 라운드·넘기기를 Vercel waitUntil 안에서 한다
       - 넘기는 쪽은 다음 틱이 202 를 줄 때까지(보통 <1초) waitUntil 로 붙잡고 기다린다(연결 실패는 재시도)
       - 그래도 끊기면 잠금(75초)이 풀린 뒤 op=kick(외부 하트비트: jumo push-cron 2분마다)이 되살린다
     매 라운드 매달린 액티비티도 정리한다(만료 → end, 도착 예정+4분·진척 없음 → 도착 end,
     30분 방치된 paused → 삭제). 외부 크론이 그냥 op=tick 을 때리는 예전 방식도 그대로 동작한다.

   저장소는 기존 테이블 public.sf_cache (lib/supabase.js 참고) — SQL 실행이 필요 없다.

   op 라우팅:
     POST ?op=register  {tripId, token, env, attrs, state, track, paused}
     POST ?op=update    같은 형식(부분 허용) — 앱이 포그라운드면 paused:true 로 서버 푸시를 멈춘다
     POST ?op=end       {tripId, local}
     GET  ?op=tick      헤더 x-cron-secret (chain=1 이면 체인 모드, dry=1 이면 계산만)
     GET/POST ?op=kick  인증 없음 — 잠금이 비었고 할 일이 있으면 체인만 띄운다(스스로 푸시하지 않음).
                        + 운행 대기 등록부에 열차가 있거나 최근 활동이 있는 노선의 이력을 이어 받는다(우선 최대 3노선·노선당 60초)
                        + 남는 예산은 ALLOWED 전체 노선을 라운드로빈으로 채운다(한 번에 최대 4노선 — 우선순위+로빈 합계,
                          커서는 sf_cache 'ssl:la:scan' 에 저장돼 인스턴스·호출 사이에도 이어 돈다: 2분마다 kick → 18개 노선을 ~9분에 한 바퀴)
     GET/POST ?op=cleanup  헤더 x-cron-secret — 매달린 액티비티를 지금 정리(dry=1 이면 판정만)
     GET  ?op=hist&line=5호선  인증 없음 — 노선 관측 이력(운행 대기·탄 열차 교체 판정용, lib/train-hist.js).
                        앱이 백그라운드에 있던 동안 웹이 못 본 열차 움직임을 복귀 때 채워 넣는다(공개 피드에서 나온 값뿐)
                        응답의 parked = 그 노선 운행 대기 등록부 항목({line,no,stn,since,lastSeen}, sf_cache 'ssl:la:parked')
     GET  ?op=diag      헤더 x-cron-secret — 환경 점검(값은 안 돌려준다)
                        probe=1 이면 APNs 에 실제로 한 번 쏴서 키/토픽 설정을 확인한다

   환경변수: APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, SUPABASE_URL,
             SUPABASE_SERVICE_KEY 또는 SUPABASE_ANON_KEY(또는 SUPABASE_ANON_FALLBACK),
             SUBWAY_API_KEY / (선택) LA_CRON_SECRET, LA_SELF_URL, LA_TABLE */

const crypto = require("crypto");
const { fetchLinePositions, ALLOWED: FEED_LINES } = require("../lib/position-feed");
const TH = require("../lib/train-hist");
const { computeRow, sweepRow, overdueEnd, progressKey, lastProgressAt } = require("../lib/la-core");
const { createPusher, isDeadToken, normalizePem } = require("../lib/apns");
const store = require("../lib/supabase");

const TRIP_TTL_MS = 3 * 60 * 60 * 1000;   /* 행 수명 3시간 — 앱이 죽어도 영원히 푸시하지 않도록 */
const MAX_ROWS = 50;                      /* 한 틱에서 처리할 최대 행 수 */
const DISMISS_AFTER_SEC = 8;
const CHAIN_ROUND_MS = 50 * 1000;         /* 이 시각(호출 시작 기준)에 다음 틱을 띄운다 */
const ROUND_BUDGET_MS = 55 * 1000;        /* 한 호출이 쓰는 총 시간 상한(maxDuration 60초 안) */
const HANDOFF_TIMEOUT_MS = 4000;          /* 다음 틱이 202 를 돌려주길 기다리는 1회 상한 */
const KICK_WAIT_MS = 3000;                /* register/update/end/kick 가 새 체인 시작을 기다리는 상한 */
const LOCK_TTL_MS = 75 * 1000;            /* 체인 잠금 임대 — 한 라운드(60초)보다 넉넉히 */
const PROBE_TOKEN = "0".repeat(64);       /* 일부러 틀린 기기 토큰 — APNs 가 '키는 맞다'까지만 알려주게 한다 */
const PROBE_TIMEOUT_MS = 8000;

/* 노선 관측 이력 — 인스턴스가 살아 있는 동안 메모리에 이어 두고, 라운드마다 sf_cache('ssl:la:hist:<노선>')와 합쳐 저장한다.
   (체인 호출은 다른 인스턴스에 떨어질 수 있다 → 저장본이 기준, 메모리는 저장 실패·지연 대비) */
const memHist = new Map();   /* line → hist */
const histFeedAt = new Map();   /* line → op=hist 가 마지막으로 피드를 직접 받은 시각(노선당 20초에 한 번) */
const HIST_FEED_MIN_MS = 20 * 1000;

/* 메모리 + 저장본을 합친 이력. 저장소 오류는 삼킨다(메모리만으로 계속). */
async function loadHist(line, now) {
  const mem = memHist.get(line) || TH.emptyHist();
  let saved = null;
  try { saved = await store.getHist(line); } catch (e) { console.warn("[la] hist load", line, e && e.message); }
  if (saved) TH.histMerge(mem, TH.histUnpack(saved));
  TH.histPrune(mem, now);
  memHist.set(line, mem);
  return mem;
}

/* 운행 대기 등록부(lib/train-hist.js regUpdate) — sf_cache('ssl:la:parked') 한 행. 이력(60분)보다 오래(6시간) 남아,
   아무도 그 노선을 보지 않던 사이에도 오래 서 있던 열차를 다시 보는 순간 '운행 대기'로 알아본다.
   저장본이 기준이다(읽기에 성공하면 그걸로 바꾼다 — 다른 인스턴스가 지운 항목을 되살리지 않게). 읽기 실패 시에만 메모리. */
let memReg = TH.emptyReg();
const REG_ACTIVE_MS = 30 * 60000;         /* 이만큼 안에 주행·앱(op=hist)이 본 노선 = '최근 활동' — op=kick 이 이력을 이어 받는다 */
const REG_ACTIVE_SAVE_MS = 5 * 60000;     /* 활동 시각만 바뀐 경우 이 간격으로만 저장 */
const KICK_HIST_LINES = 3;                /* op=kick 한 번에 우선순위(등록부·최근 활동)로 받는 노선 수 상한 */
const KICK_LINES_TOTAL = 4;               /* op=kick 한 번의 전체 상한(우선순위 + 라운드로빈) */
const KICK_HIST_MIN_MS = 60 * 1000;       /* 노선당 피드 조회 간격 하한(op=kick) */
async function loadReg(now) {
  try {
    const saved = await store.getParked();
    memReg = saved ? TH.regUnpack(saved) : TH.emptyReg();
  } catch (e) { console.warn("[la] parked load", e && e.message); }
  TH.regPrune(memReg, now);
  return memReg;
}
const saveReg = (reg, now) => store.saveParked({ trains: reg.trains, lines: reg.lines || {}, at: reg.at || now }, now)
  .catch((e) => console.warn("[la] parked save", e && e.message));
/* 노선 활동 표시 — 바뀌어서 저장이 필요하면 true */
function markActive(reg, line, now) {
  reg.lines = reg.lines || {};
  const prev = Number(reg.lines[line]) || 0;
  reg.lines[line] = now;
  return now - prev >= REG_ACTIVE_SAVE_MS;
}

/* 테스트에서 APNs 전송을 갈아끼울 수 있게 한 겹 둔다 */
let pusherFactory = createPusher;
let chainRoundMs = CHAIN_ROUND_MS;        /* 테스트가 50초를 기다리지 않도록(_setTiming) */

const PROBE_STATE = {
  remainMin: 0, arriveAt: "", line: "", colorHex: "#8A8F98", nextStation: "", legTo: "",
  isLast: true, done: false, waiting: false, waitMin: 0, toLine: "", toColorHex: "#8A8F98",
  alight: false, endEpoch: 0,
};

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 경쟁용 타임아웃 — 먼저 끝나면 타이머가 프로세스를 붙잡지 않도록 unref 한다 */
const timeoutIn = (ms, val) => new Promise((r) => { const t = setTimeout(() => r(val), ms); if (t.unref) t.unref(); });

/* 틱 인증. LA_CRON_SECRET 를 직접 정하는 쪽이 낫지만, 없으면 APNs 키 식별자에서 유도해
   체인이 추가 설정 없이 스스로를 인증할 수 있게 한다(값 자체는 밖으로 나가지 않는다). */
function cronSecret() {
  if (process.env.LA_CRON_SECRET) return process.env.LA_CRON_SECRET;
  return crypto.createHash("sha256")
    .update(`${process.env.APNS_KEY_ID || ""}|${process.env.APNS_TEAM_ID || ""}`)
    .digest("hex");
}

function selfUrl() {
  if (process.env.LA_SELF_URL) return String(process.env.LA_SELF_URL).replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "https://seoul-subway-lyart.vercel.app";
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/* Vercel waitUntil — 응답을 보낸 뒤에도 이 약속이 끝날 때까지 함수를 얼리지 않는다.
   @vercel/functions 의 waitUntil 이 내부에서 하는 일과 같다(의존성 추가 없이). 없으면 null. */
function getWaitUntil() {
  try {
    const ctx = globalThis[Symbol.for("@vercel/request-context")];
    const c = ctx && typeof ctx.get === "function" ? ctx.get() : null;
    return c && typeof c.waitUntil === "function" ? c.waitUntil.bind(c) : null;
  } catch (e) { return null; }
}

/* 다음 틱 호출 1회 — 받아들였다는 응답(2xx)까지 기다린다. 타임아웃이면 AbortController 로 끊는다.
   @returns {ok, status, timeout, error} */
async function callTick(cid, timeoutMs) {
  const url = `${selfUrl()}/api/la?op=tick&chain=1&cid=${encodeURIComponent(cid)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(200, timeoutMs));
  try {
    const r = await fetch(url, { headers: { "x-cron-secret": cronSecret() }, signal: ctrl.signal });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    const timeout = ctrl.signal.aborted;
    return { ok: false, status: 0, timeout, error: timeout ? "timeout" : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

/* 다음 틱에게 넘긴다. 연결 자체가 실패(요청이 안 나감)·502/503 이면 기한 안에서 다시 시도하고,
   타임아웃은 다시 보내지 않는다 — 이미 도착해 돌고 있을 수 있어서(같은 cid 로 두 줄이 되면 안 된다).
   deadline: 이 호출이 써도 되는 마지막 시각(ms) */
async function handoff(cid, deadline) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = deadline - Date.now();
    if (left < 300) break;
    last = await callTick(cid, Math.min(HANDOFF_TIMEOUT_MS, left));
    if (last.ok || last.timeout) break;
    if (last.status && last.status !== 502 && last.status !== 503) break;   /* 4xx/500 — 다시 보내도 같다 */
    console.warn("[la] handoff retry", attempt + 1, last.status, last.error || "");
    await sleep(Math.min(500, Math.max(0, deadline - Date.now() - 300)));
  }
  if (last && !last.ok) console.warn("[la] handoff", last.status, last.error || "");
  return last || { ok: false, status: 0, error: "no-time" };
}

/* 백그라운드 작업 등록. waitUntil 이 있으면 거기 맡기고 capMs 만큼만 기다린다(0 이면 안 기다림).
   없으면(로컬·테스트) 최대 fallbackMs 까지 직접 기다린다. */
async function background(p, { capMs = 0, fallbackMs = KICK_WAIT_MS } = {}) {
  const guarded = Promise.resolve(p).catch((e) => console.warn("[la] bg", e && e.message));
  const wu = getWaitUntil();
  if (wu) {
    wu(guarded);
    if (capMs > 0) await Promise.race([guarded, timeoutIn(capMs)]);
    return true;
  }
  await Promise.race([guarded, timeoutIn(fallbackMs)]);
  return false;
}

/* 체인이 안 돌고 있으면 새로 띄운다 — register/update/end, op=kick(외부 하트비트) 공용.
   조건: (a) 살아 있는 잠금이 없고 (b) 서버가 할 일이 있는 행이 하나라도 있을 것
         (활성 = paused 아님·만료 전·토큰 있음, 또는 정리(만료 종료·오래된 paused 삭제)가 필요한 행).
   knownActive: 호출자가 방금 활성 행을 저장했다면 목록 조회를 건너뛴다.
   @returns {kicked, reason?, cid?} */
async function kickChain({ knownActive = false } = {}) {
  try {
    const now = Date.now();
    const lock = await store.getLock();
    if (!store.lockFree(lock, now)) return { kicked: false, reason: "locked" };
    if (!knownActive) {
      const all = await store.listTrips();
      const work = store.activeTrips(all, now).length || all.some((r) => sweepRow(r, now));
      if (!work) return { kicked: false, reason: "no-active-rows" };
    }
    const cid = crypto.randomUUID();
    await store.setLock(cid, now + LOCK_TTL_MS, now);
    /* 새 틱이 받아들일 때까지(보통 <1초) — waitUntil 로 붙잡아 응답 후에도 요청이 나가게 한다 */
    await background(handoff(cid, Date.now() + KICK_WAIT_MS), { capMs: KICK_WAIT_MS, fallbackMs: KICK_WAIT_MS });
    return { kicked: true, cid };
  } catch (e) {
    console.warn("[la] kick", e && e.message);
    return { kicked: false, reason: "error" };
  }
}

/* ── op=register / op=update ─────────────────────────────────────────────── */
async function opRegister(req, res, { isUpdate }) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  if (!isUpdate && !b.token) return res.status(400).json({ error: "token required" });

  const now = Date.now();
  const patch = { trip_id: tripId, expires_at: iso(now + TRIP_TTL_MS) };   /* 살아 있다는 신호 = 수명 연장 */
  if (b.token != null) patch.token = String(b.token);
  if (b.env != null) patch.env = b.env === "sandbox" ? "sandbox" : "prod";
  if (b.attrs != null) patch.attrs = b.attrs;
  if (b.state != null) patch.state = b.state;
  if (b.track !== undefined) patch.track = b.track || null;
  if (b.paused != null) patch.paused = !!b.paused;
  if (b.state != null || b.track !== undefined) patch.last_progress_at = iso(now);   /* 앱이 새 위치를 줬다 = 진척 */

  let row = null, created = false;
  if (isUpdate) row = await store.patchTrip(tripId, patch, now);
  if (!row) {
    if (!patch.token) return res.status(404).json({ error: "unknown tripId (send op=register first)" });
    row = Object.assign({
      trip_id: tripId, env: "prod", attrs: {}, state: {}, track: null, paused: false,
      last_push_at: null, last_feed_at: null,
    }, patch);
    await store.saveTrips([row], now);
    created = true;
  }

  /* 체인이 돌고 있는지 확인하고 없으면 띄운다 — 이 행이 paused:false 면 조회 없이,
     paused:true 여도 다른 활성 행이 있으면 띄운다(자가 복구) */
  const k = await kickChain({ knownActive: row.paused === false && !!row.token });
  return res.status(200).json({ ok: true, created, paused: !!row.paused, kicked: k.kicked });
}

/* ── op=end ──────────────────────────────────────────────────────────────── */
async function opEnd(req, res) {
  const b = readBody(req);
  const tripId = String(b.tripId || "").trim();
  if (!tripId) return res.status(400).json({ error: "tripId required" });
  const local = !!b.local;

  let pushed = false;
  if (!local) {
    const row = await store.getTrip(tripId);
    if (row && row.token) {
      const pusher = pusherFactory();
      try {
        const st = Object.assign({}, row.state || {}, { done: true, waiting: false, alight: false });
        const r = await pusher.send({
          token: row.token, env: row.env, contentState: st, event: "end", priority: 10,
          dismissalSec: Math.floor(Date.now() / 1000) + DISMISS_AFTER_SEC, staleSec: 300,
        });
        pushed = r.status === 200;
        if (!pushed) console.warn("[la] end push", r.status, r.reason);
      } finally { pusher.close(); }
    }
  }
  await store.deleteTrips([tripId]);
  const k = await kickChain();   /* 다른 활성 주행이 있는데 체인이 죽어 있으면 되살린다 */
  return res.status(200).json({ ok: true, pushed, kicked: k.kicked });
}

/* ── 푸시·삭제·저장 실행 ────────────────────────────────────────────────── */
/* jobs: computeRow/sweepRow/overdueEnd 결과 모양 {tripId, token, env, state, track, push, remove}
   byId: tripId → 원래 행 (저장할 때 합친다) */
async function applyJobs(jobs, byId, now) {
  let pushed = 0, ended = 0, errors = 0;
  const dead = [], remove = [], save = [];
  if (!jobs.length) return { pushed, ended, errors, gone: [] };
  const pusher = pusherFactory();
  try {
    await Promise.all(jobs.map(async (x) => {
      let isDead = false;
      if (x.push && x.token) {
        let r;
        try {
          r = await pusher.send({
            token: x.token, env: x.env, contentState: x.state, event: x.push.event,
            priority: x.push.priority, alert: x.push.alert,
            dismissalSec: x.push.dismissalSec, staleSec: x.push.staleSec,
          });
        } catch (e) { r = { status: 0, reason: String((e && e.message) || e) }; }
        if (r.status === 200) { pushed++; if (x.push.event === "end") ended++; }
        else if (isDeadToken(r)) { isDead = true; dead.push(x.tripId); errors++; console.warn("[la] dead token", x.tripId, r.status, r.reason); }
        else { errors++; console.warn("[la] push fail", x.tripId, x.note || "", r.status, r.reason); }
      }
      /* 끝내는 행은 end 푸시가 실패해도 지운다 — 남겨 두면 다음 틱에 또 끝내려다 영원히 남는다 */
      if (x.remove || isDead) { if (!isDead) remove.push(x.tripId); return; }
      const orig = byId.get(x.tripId) || {};
      const moved = progressKey(x.state, x.track) !== progressKey(orig.state, orig.track);
      const lp = moved ? now : lastProgressAt(orig);
      save.push(Object.assign({}, orig, {
        state: x.state,
        track: x.track,
        last_push_at: x.push ? iso(now) : orig.last_push_at || null,
        last_feed_at: iso(now),
        last_progress_at: lp ? iso(lp) : iso(now),
      }));
    }));
  } finally { try { pusher.close(); } catch (e) {} }

  const gone = [...new Set(remove.concat(dead))];
  await Promise.all([
    gone.length ? store.deleteTrips(gone).catch((e) => console.warn("[la] delete", e.message)) : null,
    save.length ? store.saveTrips(save, now).catch((e) => console.warn("[la] save", e.message)) : null,
  ].filter(Boolean));
  return { pushed, ended, errors, gone };
}

const jobView = (x) => ({
  tripId: x.tripId, note: x.note, changed: x.changed, remove: x.remove,
  push: x.push ? { event: x.push.event, priority: x.push.priority, alert: x.push.alert } : null,
  state: x.state,
  track: x.track ? { no: x.track.no, line: x.track.line, legIdx: x.track.legIdx, legEndedAt: x.track.legEndedAt || null,
    switchedFrom: x.track.switchedFrom || null } : null,
});

/* 틱 1라운드 — 정리(만료·오래된 paused) → 활성 행 추적·푸시(+지연 종료). 네트워크 오류는 throw. */
async function runRound(now, { dry = false } = {}) {
  const all = await store.listTrips();
  const byId = new Map(all.map((r) => [r.trip_id, r]));

  /* 1) 정리 — 활성 행이 하나도 없어도 매 라운드 돈다 */
  const sweeps = [];
  for (const r of all) { const x = sweepRow(r, now); if (x) sweeps.push(x); }
  const swept = new Set(sweeps.map((x) => x.tripId));

  /* 2) 활성 행 추적 */
  const active = store.activeTrips(all.filter((r) => !swept.has(r.trip_id)), now);
  const rows = active.slice(0, MAX_ROWS);

  /* 필요한 노선을 모아 한 번씩만 조회한다(행마다 부르지 않는다) */
  const lines = new Set();
  for (const r of rows) {
    const t = r.track;
    if (!t || !t.no) continue;
    if (t.line) lines.add(t.line);
    const legs = Array.isArray(t.legs) ? t.legs : [];
    const nl = legs[(Number(t.legIdx) || 0) + 1];
    if (t.legEndedAt && nl && nl.line) lines.add(nl.line);   /* 환승 대기 → 다음 구간 노선도 본다 */
  }
  const feedMap = new Map();
  await Promise.all([...lines].map(async (ln) => {
    feedMap.set(ln, await fetchLinePositions(ln, { timeoutMs: 5000, maxAgeMs: 4000 }));
  }));
  const feed = (ln) => feedMap.get(ln) || [];

  /* 노선 관측 이력에 이번 피드를 쌓는다(운행 대기 판정·탄 열차 자동 교체). 저장 실패는 무시한다.
     이력은 노선별로만 쌓고 찾는다(열차번호는 노선끼리 겹친다) — 피드도 노선별, computeRow 도 track.line 의 이력만 본다. */
  const hists = new Map();
  let reg = null, regDirty = false;
  if (lines.size) {
    const loadedReg = await loadReg(now);
    reg = dry ? TH.regUnpack(JSON.parse(JSON.stringify(loadedReg))) : loadedReg;   /* dry 는 등록부도 건드리지 않는다 */
  }
  await Promise.all([...lines].map(async (ln) => {
    const loaded = await loadHist(ln, now);
    const h = dry ? TH.histMerge(TH.emptyHist(), loaded) : loaded;   /* dry 는 메모리 이력도 건드리지 않는다 */
    TH.histObserve(h, feed(ln), now, ln);
    TH.histPrune(h, now);
    hists.set(ln, h);
  }));
  /* 운행 대기 등록부: 오래 서 있는 열차를 기록하고, 다시 보인 열차의 정차 시작을 이력에 되돌린다(computeRow 전에) */
  for (const [ln, h] of hists) { if (TH.regUpdate(reg, ln, h, now)) regDirty = true; if (markActive(reg, ln, now)) regDirty = true; }
  if (!dry) {
    await Promise.all([...hists].map(([ln, h]) =>
      store.saveHist(ln, TH.histPack(h), now).catch((e) => console.warn("[la] hist save", ln, e && e.message))));
    if (reg && regDirty) await saveReg(reg, now);
  }

  const results = rows.map((r) => {
    try {
      const x = computeRow(r, feed, now, (ln) => hists.get(ln) || null);
      return overdueEnd(r, x, now) || x;   /* 도착 예정이 한참 지났고 진척 없음 → 도착으로 끝낸다 */
    } catch (e) { console.warn("[la] compute", r.trip_id, e && e.message); return null; }
  }).filter(Boolean);

  if (dry) {
    return {
      dry: true, rows: rows.length, active: active.length, lines: [...lines],
      swept: sweeps.map(jobView), results: results.map(jobView), remaining: active.length,
    };
  }

  const out = await applyJobs(sweeps.concat(results), byId, now);
  const goneActive = active.filter((r) => out.gone.includes(r.trip_id)).length;
  return {
    rows: rows.length, pushed: out.pushed, ended: out.ended, errors: out.errors, swept: sweeps.length,
    remaining: Math.max(0, active.length - goneActive),
  };
}

/* 체인 라운드: 일 → (남았으면) 호출 시작 기준 50초까지 대기 → 잠금 갱신 → 다음 틱에 넘김.
   라운드가 실패해도(Supabase 순간 오류 등) 체인은 이어 간다 — 한 번의 실패로 끊기지 않게. */
async function chainRound(cid, startedAt) {
  let result, remaining;
  try {
    result = await runRound(startedAt);
    remaining = result.remaining;
  } catch (e) {
    console.warn("[la] round", e && e.message);
    result = { error: String((e && e.message) || e) };
    remaining = -1;   /* 모름 → 이어 간다 */
  }
  if (remaining === 0) {
    await store.clearLock().catch(() => {});
    return Object.assign(result, { chain: { cid, remaining: 0, next: false } });
  }
  await sleep(Math.max(0, chainRoundMs - (Date.now() - startedAt)));
  /* 넘기기 직전에 잠금이 여전히 내 것인지 본다 — 사이에 다른 체인이 잡았으면 물러난다 */
  const lock = await store.getLock().catch(() => undefined);
  if (lock !== undefined && !store.lockOwned(lock, cid, Date.now())) {
    return Object.assign(result, { chain: { cid, remaining, next: false, skipped: "locked" } });
  }
  await store.setLock(cid, Date.now() + LOCK_TTL_MS).catch(() => {});
  const h = await handoff(cid, startedAt + ROUND_BUDGET_MS);
  return Object.assign(result, { chain: { cid, remaining, next: !!h.ok, handoff: h.ok ? "ok" : (h.error || h.status) } });
}

/* ── op=tick ─────────────────────────────────────────────────────────────── */
async function opTick(req, res) {
  const startedAt = Date.now();
  if (req.headers["x-cron-secret"] !== cronSecret()) return res.status(401).json({ error: "unauthorized" });

  const dry = req.query.dry === "1" || req.query.dry === "true";
  const chain = req.query.chain === "1" || req.query.chain === "true";
  const cid = String(req.query.cid || "") || crypto.randomUUID();

  if (dry) return res.status(200).json(await runRound(startedAt, { dry: true }));

  if (!chain) {
    const r = await runRound(startedAt);
    delete r.remaining;
    return res.status(200).json(r);
  }

  /* 체인은 한 줄만 돈다 — 잠금이 남의 것이고 아직 살아 있으면 이 호출은 조용히 물러난다 */
  const lock = await store.getLock();
  if (!store.lockOwned(lock, cid, startedAt)) {
    return res.status(200).json({ rows: 0, pushed: 0, ended: 0, errors: 0, skipped: "locked" });
  }
  await store.setLock(cid, startedAt + LOCK_TTL_MS, startedAt);

  /* waitUntil 이 있으면 곧바로 202 — 부른 쪽(이전 틱)의 fetch 가 1초 안에 끝나고,
     이 호출은 응답 뒤에도 얼지 않고 라운드와 다음 넘기기까지 마친다. */
  const wu = getWaitUntil();
  if (wu) {
    wu(chainRound(cid, startedAt).catch((e) => console.warn("[la] chain", e && e.message)));
    return res.status(202).json({ accepted: true, cid });
  }
  /* waitUntil 이 없는 환경(로컬 등) — 끝까지 돌고 응답한다 */
  const r = await chainRound(cid, startedAt);
  delete r.remaining;
  return res.status(200).json(r);
}

/* ── op=kick ─────────────────────────────────────────────────────────────── */
/* 인증 없는 자가 복구 — 잠금이 비었고 할 일이 있을 때만 체인을 띄운다. 스스로는 푸시하지 않는다.
   잠금(75초 임대)이 곧 속도 제한이다. 외부 하트비트(jumo push-cron, 2분마다)가 부른다. */
async function opKick(req, res) {
  const [k, hl] = await Promise.all([kickChain(), refreshIdleLines(Date.now())]);
  const body = k.kicked ? { kicked: true } : { kicked: false, reason: k.reason };
  if (hl.length) body.hist = hl;
  return res.status(200).json(body);
}

/* 하트비트(op=kick, 2분마다)가 주행 없는 동안에도 노선 이력·운행 대기 등록부를 이어 간다 —
   1) 우선순위: 등록부에 열차가 있는 노선(최근에 본 순) → 최근 활동(30분 안에 주행·op=hist) 노선. 최대 3노선.
   2) 남는 예산(전체 상한 4노선까지)은 ALLOWED 전체를 라운드로빈으로 채운다 — 가장 오래 안 받은 노선부터,
      커서는 sf_cache('ssl:la:scan' {i,at})에 남겨 인스턴스·호출 사이에도 이어 돈다(2분마다 4노선 → 18노선 ~9분에 한 바퀴,
      8분 이상 벌어진 두 관측이면 정차 판정에 충분하다).
   노선당 60초에 한 번(인스턴스 메모리 + 저장된 이력의 at 으로 인스턴스 간에도). 오류는 삼킨다.
   @returns 이번에 피드를 받은 노선 목록 */
async function refreshIdleLines(now) {
  try {
    const reg = await loadReg(now);
    const pri = new Map();
    for (const e of Object.values(reg.trains || {})) {
      if (!e || !FEED_LINES.has(e.line)) continue;
      pri.set(e.line, Math.max(pri.get(e.line) || 0, 2e13 + (Number(e.lastSeen) || 0)));   /* 등록부 노선이 먼저 */
    }
    for (const [ln, t] of Object.entries(reg.lines || {})) {
      if (!FEED_LINES.has(ln) || now - (Number(t) || 0) > REG_ACTIVE_MS || pri.has(ln)) continue;
      pri.set(ln, Number(t) || 0);
    }
    const cand = [...pri].sort((a, b) => b[1] - a[1]).map(([ln]) => ln)
      .filter((ln) => now - (histFeedAt.get(ln) || 0) >= KICK_HIST_MIN_MS).slice(0, KICK_HIST_LINES);

    /* 라운드로빈으로 나머지 예산을 채운다 — 저장된 커서(없으면 0)부터 ALLOWED 를 훑어,
       이미 뽑혔거나 60초 안에 받은 노선은 건너뛴다. 커서는 훑은 만큼(비어 걸러졌어도) 전진시켜 저장한다. */
    const picked = new Set(cand);
    const lines = [...FEED_LINES];
    const need = Math.max(0, KICK_LINES_TOTAL - cand.length);
    let scan = null;
    if (need > 0) { try { scan = await store.getScan(); } catch (e) { console.warn("[la] scan load", e && e.message); } }
    const startI = scan && Number.isFinite(scan.i) ? ((Math.trunc(scan.i) % lines.length) + lines.length) % lines.length : 0;
    const rot = [];
    let steps = 0;
    for (; need > 0 && steps < lines.length && rot.length < need; steps++) {
      const ln = lines[(startI + steps) % lines.length];
      if (picked.has(ln)) continue;
      if (now - (histFeedAt.get(ln) || 0) < KICK_HIST_MIN_MS) continue;
      rot.push(ln);
      picked.add(ln);
    }
    if (steps > 0) {
      await store.saveScan({ i: (startI + steps) % lines.length, at: now }).catch((e) => console.warn("[la] scan save", e && e.message));
    }
    cand.push(...rot);

    if (!cand.length) return [];
    let dirty = false;
    const done = [];
    await Promise.all(cand.map(async (ln) => {
      const h = await loadHist(ln, now);
      if (now - (Number(h.at) || 0) < KICK_HIST_MIN_MS) return;   /* 다른 인스턴스·체인이 방금 받았다 */
      histFeedAt.set(ln, now);
      const list = await fetchLinePositions(ln, { timeoutMs: 4000, maxAgeMs: 4000 }).catch(() => []);
      if (!list.length) return;
      TH.histObserve(h, list, now, ln); TH.histPrune(h, now);
      if (TH.regUpdate(reg, ln, h, now)) dirty = true;
      done.push(ln);
      await store.saveHist(ln, TH.histPack(h), now).catch((e) => console.warn("[la] hist save", ln, e && e.message));
    }));
    if (dirty) await saveReg(reg, now);
    return done;
  } catch (e) {
    console.warn("[la] kick hist", e && e.message);
    return [];
  }
}

/* ── op=cleanup ──────────────────────────────────────────────────────────── */
/* 시크릿 필요. 매달린 액티비티를 지금 바로 정리한다(피드 없이 저장된 상태만으로 판정):
   만료 → end(즉시 dismiss), 도착 예정+4분 지남·4분간 진척 없음 → end(도착, 60초 뒤 dismiss),
   30분 넘게 방치된 paused → 푸시 없이 삭제. 그 외 행은 건드리지 않는다. dry=1 이면 판정만. */
async function opCleanup(req, res) {
  if (req.headers["x-cron-secret"] !== cronSecret()) return res.status(401).json({ error: "unauthorized" });
  const now = Date.now();
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const all = await store.listTrips();
  const byId = new Map(all.map((r) => [r.trip_id, r]));
  const jobs = [];
  for (const r of all) {
    let x = sweepRow(r, now);
    if (!x && !r.paused && r.token) {
      const same = { tripId: r.trip_id, token: r.token, env: r.env || "prod", state: r.state || {}, track: r.track || null,
        changed: false, push: null, remove: false, note: "" };
      x = overdueEnd(r, same, now);
    }
    if (x) jobs.push(x);
  }
  if (dry) return res.status(200).json({ dry: true, rows: all.length, jobs: jobs.map(jobView) });
  const out = await applyJobs(jobs, byId, now);
  return res.status(200).json({
    rows: all.length, cleaned: out.gone.length, pushed: out.pushed, ended: out.ended, errors: out.errors,
    notes: jobs.reduce((m, x) => { m[x.note] = (m[x.note] || 0) + 1; return m; }, {}),
  });
}

/* ── op=hist ─────────────────────────────────────────────────────────────── */
/* 인증 없음(공개 위치 피드에서 나온 값뿐). 웹이 앱 실행·복귀·열차 고르기 전에 자기 이력에 합친다.
   체인은 활성 주행이 있는 노선만 관측하므로, 이력이 20초 넘게 묵었으면 여기서 피드를 한 번 받아 쌓고 저장한다
   (노선당 20초에 한 번 — 호출이 몰려도 상위 API 는 그 이상 부르지 않는다). 첫 요청은 한 장면뿐이지만,
   그 뒤로는 앱이 이 노선을 볼 때마다 서버 이력이 자라 다음 실행 때 운행 대기 열차를 바로 알 수 있다. */
async function opHist(req, res) {
  const line = String((req.query && req.query.line) || "");
  if (!FEED_LINES.has(line)) return res.status(400).json({ error: "unknown line" });
  const now = Date.now();
  const [h, reg] = await Promise.all([loadHist(line, now), loadReg(now)]);
  let observed = false;
  if (now - (Number(h.at) || 0) >= HIST_FEED_MIN_MS && now - (histFeedAt.get(line) || 0) >= HIST_FEED_MIN_MS) {
    histFeedAt.set(line, now);
    const list = await fetchLinePositions(line, { timeoutMs: 4000, maxAgeMs: 4000 }).catch(() => []);
    if (list.length) {
      TH.histObserve(h, list, now, line); TH.histPrune(h, now);
      observed = true;
    }
  }
  /* 등록부를 이력에 되돌려 쓴 뒤 돌려준다(오래 서 있던 열차가 처음 본 것처럼 보이지 않게). 등록부 항목도 함께 — 웹이 자기 등록부에 합친다 */
  let regDirty = TH.regUpdate(reg, line, h, now);
  if (markActive(reg, line, now)) regDirty = true;   /* 이 노선을 앱이 보고 있다 → op=kick 이 한동안 이력을 이어 받는다 */
  if (observed) await store.saveHist(line, TH.histPack(h), now).catch((e) => console.warn("[la] hist save", line, e && e.message));
  if (regDirty) await saveReg(reg, now);
  return res.status(200).json({ line, observed, hist: TH.histPack(h), parked: TH.regForLine(reg, line) });
}

/* ── op=diag ─────────────────────────────────────────────────────────────── */
/* 배포 환경 점검 — 값은 절대 돌려주지 않는다(존재 여부·길이·파싱 성공만). */
async function opDiag(req, res) {
  if (req.headers["x-cron-secret"] !== cronSecret()) return res.status(401).json({ error: "unauthorized" });

  const rawKey = process.env.APNS_KEY || "";
  const key = rawKey.replace(/\\n/g, "\n");
  const canParse = (k) => { if (!k) return false; try { crypto.createPrivateKey(k); return true; } catch (e) { return false; } };
  const keyParses = canParse(key);
  const keyNormalizedParses = canParse(normalizePem(rawKey));   /* 따옴표·한 줄·본문만 붙여넣기까지 펴 본 결과 */

  const keySource = process.env.SUPABASE_SERVICE_KEY ? "service"
    : process.env.SUPABASE_ANON_KEY ? "anon-env"
    : process.env.SUPABASE_ANON_FALLBACK ? "anon-fallback"
    : store.apiKey() ? "anon-builtin" : "none";   /* lib/supabase.js 의 공개 anon 폴백 */

  let reachable = 0;
  if (process.env.SUPABASE_URL && keySource !== "none") {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${store.CACHE_TABLE}?select=date&limit=1`, { headers: store.sbHeaders() });
      reachable = r.status;
    } catch (e) { reachable = 0; }
  }

  /* probe=1: 진짜 APNs 에 한 번 쏴 본다(기기 토큰은 0 x64 라 배달되지 않는다).
     reason 으로 무엇이 틀렸는지 갈린다 —
       BadDeviceToken  → 키/kid/team/topic 은 통과. 설정 정상
       InvalidProviderToken(403) → APNS_KEY / KEY_ID / TEAM_ID 가 틀림
       TopicDisallowed(400)      → APNS_BUNDLE_ID(토픽)가 틀림 */
  let probe;
  if (req.query.probe === "1" || req.query.probe === "true") {
    const want = String(req.query.probeEnv || "both");
    const envs = want === "prod" || want === "sandbox" ? [want] : ["prod", "sandbox"];
    const pusher = pusherFactory();
    probe = {};
    try {
      await Promise.all(envs.map(async (e) => {
        try {
          const r = await Promise.race([
            pusher.send({ token: PROBE_TOKEN, env: e, contentState: PROBE_STATE, event: "update", priority: 5, staleSec: 60 }),
            timeoutIn(PROBE_TIMEOUT_MS + 500, { status: 0, reason: "timeout" }),
          ]);
          probe[e] = { status: r.status || 0, reason: r.reason || "" };   /* 토큰·페이로드는 싣지 않는다 */
        } catch (err) {
          probe[e] = { status: 0, reason: String((err && err.message) || err) };
        }
      }));
    } finally { try { pusher.close(); } catch (e) {} }
  }

  return res.status(200).json({
    apns: {
      keyPresent: !!rawKey,
      keyLen: rawKey.length,
      keyLooksPem: rawKey.includes("BEGIN PRIVATE KEY"),
      keyParses,
      keyNormalizedParses,
      keyIdLen: (process.env.APNS_KEY_ID || "").length,
      teamIdLen: (process.env.APNS_TEAM_ID || "").length,
      bundleId: process.env.APNS_BUNDLE_ID || "",
    },
    supabase: { url: process.env.SUPABASE_URL || "", keySource, reachable, table: store.dedicatedTable() || store.CACHE_TABLE },
    feed: { subwayKeyPresent: !!process.env.SUBWAY_API_KEY },
    self: selfUrl(),
    secretSource: process.env.LA_CRON_SECRET ? "env" : "derived",
    probe,
  });
}

/* ── 라우팅 ──────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const op = String((req.query && req.query.op) || "");
  try {
    if (op === "tick") return await opTick(req, res);
    if (op === "diag") return await opDiag(req, res);
    if (op === "kick") return await opKick(req, res);
    if (op === "cleanup") return await opCleanup(req, res);
    if (op === "hist") return await opHist(req, res);
    if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
    if (op === "register") return await opRegister(req, res, { isUpdate: false });
    if (op === "update") return await opRegister(req, res, { isUpdate: true });
    if (op === "end") return await opEnd(req, res);
    return res.status(400).json({ error: "unknown op (register|update|end|tick|kick|cleanup|hist|diag)" });
  } catch (e) {
    console.error("[la]", op, (e && e.stack) || e);
    if (res.headersSent) return;
    return res.status(500).json({ error: "server", message: String((e && e.message) || e) });
  }
};

module.exports.TRIP_TTL_MS = TRIP_TTL_MS;
module.exports.CHAIN_ROUND_MS = CHAIN_ROUND_MS;
module.exports.LOCK_TTL_MS = LOCK_TTL_MS;
module.exports.cronSecret = cronSecret;
module.exports.getWaitUntil = getWaitUntil;
module.exports.selfUrl = selfUrl;
/* 테스트 전용 — APNs 전송을 갈아끼운다(원복하려면 인자 없이 호출) */
module.exports._setPusherFactory = (fn) => { pusherFactory = fn || createPusher; };
module.exports._memHist = memHist;   /* 테스트 전용 */
module.exports._resetParked = () => { memReg = TH.emptyReg(); histFeedAt.clear(); };   /* 테스트 전용 */
module.exports._setTiming = (o) => { chainRoundMs = o && o.roundMs != null ? o.roundMs : CHAIN_ROUND_MS; };
