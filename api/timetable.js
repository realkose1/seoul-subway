/* Vercel 서버리스 프록시: 역별 열차 시간표를 중계한다.
   출처: 서울 열린데이터광장 일반 OpenAPI (openapi.seoul.go.kr:8088)
   인증키: 실시간 키와 별개일 수 있어 SEOUL_OPENAPI_KEY 우선, 없으면 SUBWAY_API_KEY 시도.
   시간표는 거의 변하지 않으므로 길게 캐시한다. */

const SERVICE = "SearchSTNTimeTableByIDService";

async function callUpstream(key, code, week, inout) {
  const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/${SERVICE}/1/300/${encodeURIComponent(code)}/${week}/${inout}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  const key = process.env.SEOUL_OPENAPI_KEY || process.env.SUBWAY_API_KEY;
  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "서버에 시간표 API 키가 설정되지 않았습니다 (SEOUL_OPENAPI_KEY)." });

  const code = String(req.query.code || "").trim();
  const week = String(req.query.week || "1");    /* 1=평일 2=토요일 3=일·공휴일 */
  const inout = String(req.query.inout || "1");  /* 1=상행/내선 2=하행/외선 */
  if (!/^\d{3,12}$/.test(code)) return res.status(400).json({ code: "ERROR-PARAM", message: "역 코드가 올바르지 않습니다." });
  if (!["1", "2", "3"].includes(week) || !["1", "2"].includes(inout)) return res.status(400).json({ code: "ERROR-PARAM", message: "week 또는 inout 값이 올바르지 않습니다." });

  try {
    const data = await callUpstream(key, code, week, inout);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ code: "ERROR-UPSTREAM", message: `시간표 API 호출 실패: ${(e && e.cause && e.cause.code) || (e && e.message) || e}` });
  }
};
