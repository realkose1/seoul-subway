/* Vercel 서버리스 프록시: 인증키를 서버에만 두고 실시간 열차 위치를 중계합니다.
   Vercel 대시보드 → Settings → Environment Variables 에 SUBWAY_API_KEY 등록 필요 */

const ALLOWED = new Set(["1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선", "수인분당선", "신분당선", "경강선"]);

async function callUpstream(scheme, key, line) {
  const url = `${scheme}://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimePosition/0/200/${encodeURIComponent(line)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=25, stale-while-revalidate=40");
  const key = process.env.SUBWAY_API_KEY;

  /* 프록시 사용 가능 여부 확인용 (상위 API 호출 없음) */
  if (req.query.probe) return res.status(200).json({ ok: !!key, region: process.env.VERCEL_REGION || "unknown" });

  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "서버에 SUBWAY_API_KEY 환경변수가 설정되지 않았습니다." });

  const line = String(req.query.line || "");

  /* 전체 또는 부분 노선 목록(쉼표 구분): 병렬 조회해 병합. 캐시를 길게 잡아 호출량을 보호한다 */
  if (line === "ALL" || line.includes(",")) {
    const wanted = line === "ALL" ? [...ALLOWED] : line.split(",").filter(l => ALLOWED.has(l));
    if (!wanted.length) return res.status(400).json({ code: "ERROR-PARAM", message: "지원하지 않는 노선입니다." });
    res.setHeader("Cache-Control", wanted.length >= 7 ? "s-maxage=110, stale-while-revalidate=120" : "s-maxage=50, stale-while-revalidate=60");
    const results = await Promise.allSettled(wanted.map(async (ln) => {
      try { return await callUpstream("http", key, ln); }
      catch (e) { return await callUpstream("https", key, ln); }
    }));
    const merged = [];
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value.realtimePositionList)) merged.push(...r.value.realtimePositionList);
    }
    return res.status(200).json({ errorMessage: { code: "INFO-000", total: merged.length }, realtimePositionList: merged });
  }

  if (!ALLOWED.has(line)) return res.status(400).json({ code: "ERROR-PARAM", message: "지원하지 않는 노선입니다." });

  /* 인증서 체인 문제 회피를 위해 서버 간 통신은 http를 우선 사용 */
  const errors = [];
  for (const scheme of ["http", "https"]) {
    try {
      const data = await callUpstream(scheme, key, line);
      return res.status(200).json(data);
    } catch (e) {
      errors.push(`${scheme}: ${(e && e.cause && e.cause.code) || e.name || e.message}`);
    }
  }
  return res.status(502).json({ code: "ERROR-UPSTREAM", message: `실시간 API 호출 실패 (${errors.join(" / ")})` });
};
