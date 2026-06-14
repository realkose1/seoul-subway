/* Vercel 서버리스 프록시: 서울 열린데이터광장 일반 OpenAPI(openapi.seoul.go.kr:8088) 중계.
   인증키: SEOUL_OPENAPI_KEY 우선, 없으면 SUBWAY_API_KEY.
   ── 탐색 모드(임시): service/args 로 임의 서비스 호출 가능 (역코드 형식 확인용). 확정 후 시간표 전용으로 잠글 예정. */

async function callRaw(key, service, parts) {
  const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/${service}/1/300${parts ? "/" + parts : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json();
    return { j, debug: url.replace(encodeURIComponent(key), "KEY") };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  const key = process.env.SEOUL_OPENAPI_KEY || process.env.SUBWAY_API_KEY;
  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "시간표 API 키 없음" });

  const service = String(req.query.service || "SearchSTNTimeTableByIDService").replace(/[^A-Za-z]/g, "");
  const args = String(req.query.args || "").trim();
  const parts = args ? args.split("/").map(s => encodeURIComponent(s)).join("/") : "";

  try {
    const { j, debug } = await callRaw(key, service, parts);
    return res.status(200).json({ _debug: debug, ...j });
  } catch (e) {
    return res.status(502).json({ code: "ERROR-UPSTREAM", message: `${(e && e.cause && e.cause.code) || (e && e.message) || e}` });
  }
};
