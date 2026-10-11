/* 서버가 만드는 사용자 노출 문자열의 현지화 — 라이브 액티비티 알림·ContentState.
   내부 로직(피드·track 매칭)은 계속 한국어 이름으로 하고, 푸시/저장 직전의 '출력 경계'에서만 번역한다.
   모든 번역은 멱등이다: 한글이 없는 값(앱이 이미 영어로 보낸 값 등)은 그대로 돌려준다.

   lang: "ko" | "en". 행에는 attrs.lang 으로 저장한다(DB 스키마 변경 없음). 없거나 모르는 값 → "ko"(옛 앱 빌드 호환). */

/* 역명 표(한글 키 → 영어). 파일이 없어도(생성 전·배포 누락) 죽지 않고 원문으로 폴백한다.
   require("./stations-en.json") 정적 문자열이라 Vercel nft 가 번들에 포함한다. */
let STN = {};
try { STN = require("./stations-en.json") || {}; } catch (e) { STN = {}; }
const STN_LOADED = STN;

const LINE_EN = {
  "1호선": "Line 1", "2호선": "Line 2", "3호선": "Line 3", "4호선": "Line 4", "5호선": "Line 5",
  "6호선": "Line 6", "7호선": "Line 7", "8호선": "Line 8", "9호선": "Line 9",
  "수인분당선": "Suin-Bundang", "신분당선": "Shinbundang", "경의중앙선": "Gyeongui-Jungang",
  "공항철도": "AREX", "경춘선": "Gyeongchun", "경강선": "Gyeonggang", "서해선": "Seohae",
  "우이신설선": "Ui-Sinseol", "신림선": "Sillim",
};

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const hasHangul = (s) => HANGUL.test(String(s == null ? "" : s));

const normLang = (v) => (String(v == null ? "" : v).trim().toLowerCase().startsWith("en") ? "en" : "ko");
/* 행(또는 attrs)의 언어 */
const langOf = (rowOrAttrs) => {
  const a = rowOrAttrs && (rowOrAttrs.attrs !== undefined ? rowOrAttrs.attrs : rowOrAttrs);
  return normLang(a && typeof a === "object" ? a.lang : null);
};

/* 역명 → 영어. 정확히 일치 → 괄호 뒤 제거 → 끝의 '역' 제거 → 종착/순환/행/지선 제거 순으로 후보를 만들어 찾는다.
   못 찾으면 원문. 한글이 없으면 그대로. */
function stationEn(name) {
  if (name == null) return name;
  const s = String(name).trim();
  if (!s || !hasHangul(s)) return name;
  if (STN[s]) return STN[s];
  const cands = [];
  const push = (v) => { v = String(v).trim(); if (v && !cands.includes(v)) cands.push(v); };
  const noParen = s.replace(/\s*\(.*$/, "");
  const noStn = (v) => (v.length > 1 && v.endsWith("역") ? v.slice(0, -1) : v);
  const noTerm = (v) => v.replace(/(종착|지선|순환|행)$/, "");
  push(noParen);
  push(noStn(noParen));
  push(noTerm(noParen));
  push(noStn(noTerm(noParen)));
  push(noTerm(noStn(noParen)));
  push(noStn(noTerm(noStn(noParen))));
  for (const c of cands) if (STN[c]) return STN[c];
  return name;
}

function lineEn(line) {
  if (line == null) return line;
  const s = String(line).trim();
  if (!s || !hasHangul(s)) return line;
  return LINE_EN[s] || line;
}

/* Asia/Seoul 벽시계 → "오후 1:36" / "1:36 PM". 서버 시간대와 무관하게 KST 로 계산한다. */
function fmtClock(date, lang = "ko") {
  const d = date instanceof Date ? date : new Date(date);
  const k = new Date(d.getTime() + 9 * 3600 * 1000);   /* UTC 필드를 KST 벽시계로 읽는다 */
  const H = k.getUTCHours(), m = String(k.getUTCMinutes()).padStart(2, "0");
  const h12 = H % 12 === 0 ? 12 : H % 12;
  if (normLang(lang) === "en") return `${h12}:${m} ${H < 12 ? "AM" : "PM"}`;
  return `${H < 12 ? "오전" : "오후"} ${h12}:${m}`;
}

/* 이미 만들어진 "오후 1:36"(ko 표기)를 영어 "1:36 PM" 으로. 모양이 다르면(이미 영어 등) 그대로. */
function clockEn(str) {
  if (typeof str !== "string") return str;
  const m = str.trim().match(/^(오전|오후)\s*(\d{1,2}):(\d{2})$/);
  return m ? `${m[2]}:${m[3]} ${m[1] === "오전" ? "AM" : "PM"}` : str;
}

const STR = {
  alightTitle: { ko: "곧 내리세요", en: "Get off soon" },
  alightBody: { ko: "다음 역 {to}에서 내리세요", en: "Get off at the next stop, {to}" },
  alightBodyNoName: { ko: "다음 역 에서 내리세요", en: "Get off at the next stop" },
  arriveTitle: { ko: "목적지 도착", en: "Arrived" },
  arriveBody: { ko: "{to}에 도착했습니다", en: "You have arrived at {to}" },
  destination: { ko: "목적지", en: "your destination" },
};

/* tr("en", "arriveBody", {to:"강남"}) — vars 는 {name} 자리표시자에 들어간다(치환 값은 번역하지 않는다) */
function tr(lang, key, vars) {
  const e = STR[key];
  if (!e) return key;
  let s = e[normLang(lang)] || e.ko;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
  return s;
}

/* ContentState 의 사용자 노출 문자열을 lang 으로. ko 는 원본 그대로(같은 객체). 새 객체를 돌려준다(en). */
function localizeState(state, lang) {
  if (normLang(lang) !== "en" || !state || typeof state !== "object") return state;
  const o = Object.assign({}, state);
  if (typeof o.nextStation === "string") o.nextStation = stationEn(o.nextStation);
  if (typeof o.legTo === "string") o.legTo = stationEn(o.legTo);
  if (typeof o.line === "string") o.line = lineEn(o.line);
  if (typeof o.toLine === "string") o.toLine = lineEn(o.toLine);
  if (typeof o.arriveAt === "string") o.arriveAt = clockEn(o.arriveAt);
  return o;
}

/* 알림 — 곧 내리세요 / 목적지 도착 (to: 한국어 또는 이미 영어인 역명) */
function alightAlert(lang, to) {
  const name = normLang(lang) === "en" ? stationEn(to || "") : (to || "");
  if (normLang(lang) === "en" && !name) return { title: tr("en", "alightTitle"), body: tr("en", "alightBodyNoName") };
  return { title: tr(lang, "alightTitle"), body: tr(lang, "alightBody", { to: name }) };
}
function arriveAlert(lang, to) {
  const name = normLang(lang) === "en" ? stationEn(to || "") : (to || "");
  return { title: tr(lang, "arriveTitle"), body: tr(lang, "arriveBody", { to: name || tr(lang, "destination") }) };
}

module.exports = {
  stationEn, lineEn, fmtClock, clockEn, tr, normLang, langOf, hasHangul, localizeState, alightAlert, arriveAlert,
  LINE_EN,
  _setStations: (m) => { STN = m || STN_LOADED; },   /* 테스트 전용 — 인자 없음/null 이면 파일에서 읽은 표로 되돌린다 */
};
