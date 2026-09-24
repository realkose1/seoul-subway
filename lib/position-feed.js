/* 실시간 열차 위치 피드 헬퍼 — api/position.js(프록시)와 api/la.js(라이브 액티비티 틱)가 함께 쓴다.
   api/ 밖에 두어야 Vercel이 이 파일을 서버리스 함수로 배포하지 않는다(번들에는 포함된다). */

const ALLOWED = new Set(["1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선", "수인분당선", "신분당선", "경강선", "경의중앙선", "공항철도", "경춘선", "우이신설선", "서해선", "신림선"]);

/* 상위 API 1회 호출. 인증서 체인 문제 회피를 위해 서버 간 통신은 http를 우선 사용한다. */
async function callUpstream(scheme, key, line, timeoutMs = 4000) {
  const url = `${scheme}://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimePosition/0/200/${encodeURIComponent(line)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* http → https 폴백까지 묶은 한 노선 조회. 실패하면 throw. */
async function fetchLineRaw(key, line, timeoutMs) {
  try { return await callUpstream("http", key, line, timeoutMs); }
  catch (e) { return await callUpstream("https", key, line, timeoutMs); }
}

/* 같은 인스턴스가 짧은 시간에 같은 노선을 다시 물으면 재사용한다(틱 1회 안에서의 중복 호출 방지). */
const cache = new Map();   // line -> { at, list }
const CACHE_MS = 5000;

/* 노선의 열차 목록(realtimePositionList)만 돌려준다. 실패하면 빈 배열. */
async function fetchLinePositions(line, { key = process.env.SUBWAY_API_KEY, timeoutMs = 4000, maxAgeMs = CACHE_MS } = {}) {
  if (!key || !ALLOWED.has(line)) return [];
  const hit = cache.get(line);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.list;
  try {
    const data = await fetchLineRaw(key, line, timeoutMs);
    const list = Array.isArray(data && data.realtimePositionList) ? data.realtimePositionList : [];
    cache.set(line, { at: Date.now(), list });
    return list;
  } catch (e) {
    return hit ? hit.list : [];   // 직전 값이라도 있으면 그걸 쓴다(한 번의 실패로 추적이 끊기지 않도록)
  }
}

module.exports = { ALLOWED, callUpstream, fetchLineRaw, fetchLinePositions };
module.exports._resetCache = () => cache.clear();   /* 테스트 전용 — 노선별 5초 캐시가 테스트 사이에 새지 않도록 */
