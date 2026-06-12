/* Vercel 서버리스 프록시: 역별 실시간 도착정보를 중계합니다.
   position.js와 동일한 SUBWAY_API_KEY 환경변수를 사용합니다. */

async function callUpstream(scheme, key, station) {
  const url = `${scheme}://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimeStationArrival/0/40/${encodeURIComponent(station)}`;
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
  res.setHeader("Cache-Control", "s-maxage=12, stale-while-revalidate=20");
  const key = process.env.SUBWAY_API_KEY;
  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "서버에 SUBWAY_API_KEY 환경변수가 설정되지 않았습니다." });

  const station = String(req.query.station || "").trim();
  if (!station || station.length > 20) return res.status(400).json({ code: "ERROR-PARAM", message: "역명이 올바르지 않습니다." });

  /* 인증서 체인 문제 회피를 위해 서버 간 통신은 http를 우선 사용 */
  const errors = [];
  for (const scheme of ["http", "https"]) {
    try {
      const data = await callUpstream(scheme, key, station);
      return res.status(200).json(data);
    } catch (e) {
      errors.push(`${scheme}: ${(e && e.cause && e.cause.code) || e.name || e.message}`);
    }
  }
  return res.status(502).json({ code: "ERROR-UPSTREAM", message: `도착정보 API 호출 실패 (${errors.join(" / ")})` });
};
