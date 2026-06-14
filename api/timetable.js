/* Vercel 서버리스 프록시: 역명 → 노선별 열차 시간표.
   서울 열린데이터광장 OpenAPI (openapi.seoul.go.kr:8088).
   키: SEOUL_OPENAPI_KEY 우선, 없으면 SUBWAY_API_KEY (실시간 키도 이 API에서 동작 확인됨).
   1) SearchInfoBySubwayNameService 로 역명→역코드(노선별)
   2) SearchSTNTimeTableByIDService 로 코드별 시간표
   시간표는 거의 변하지 않으므로 길게 캐시. */

const HOST = "http://openapi.seoul.go.kr:8088";

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctrl.signal }); return await r.json(); }
  finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  const key = process.env.SEOUL_OPENAPI_KEY || process.env.SUBWAY_API_KEY;
  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "시간표 API 키가 설정되지 않았습니다." });

  const name = String(req.query.name || "").trim();
  const week = String(req.query.week || "1");   /* 1=평일 2=토요일 3=일·공휴일 */
  const inout = String(req.query.inout || "1");  /* 1=상행/내선 2=하행/외선 */
  if (!name || name.length > 20) return res.status(400).json({ code: "ERROR-PARAM", message: "역명이 올바르지 않습니다." });
  if (!["1", "2", "3"].includes(week) || !["1", "2"].includes(inout)) return res.status(400).json({ code: "ERROR-PARAM", message: "week 또는 inout 값 오류" });

  const K = encodeURIComponent(key);
  try {
    /* 1) 역명 → 역코드 (노선별 여러 행 가능: 환승역) */
    const info = await getJSON(`${HOST}/${K}/json/SearchInfoBySubwayNameService/1/50/${encodeURIComponent(name)}`);
    const all = (info.SearchInfoBySubwayNameService && info.SearchInfoBySubwayNameService.row) || [];
    let matched = all.filter(r => r.STATION_NM === name);
    if (!matched.length) { const bare = name.replace(/\(.*?\)/g, "").trim(); matched = all.filter(r => r.STATION_NM === bare); }
    if (!matched.length) matched = all;
    if (!matched.length) return res.status(404).json({ code: "ERROR-NOTFOUND", message: `'${name}' 역 정보를 찾을 수 없습니다.` });

    /* 2) 노선별 시간표 병렬 조회 */
    const lines = await Promise.all(matched.map(async (r) => {
      const code = r.STATION_CD;
      let trains = [];
      try {
        const tt = await getJSON(`${HOST}/${K}/json/SearchSTNTimeTableByIDService/1/500/${encodeURIComponent(code)}/${week}/${inout}`);
        const rows = (tt.SearchSTNTimeTableByIDService && tt.SearchSTNTimeTableByIDService.row) || [];
        trains = rows.map(t => ({
          left: String(t.LEFTTIME || "").slice(0, 5),
          dest: t.SUBWAYENAME || "",
          express: !!t.EXPRESS_YN && t.EXPRESS_YN !== "G",
          trainNo: t.TRAIN_NO || ""
        })).filter(t => t.left).sort((a, b) => a.left.localeCompare(b.left));
      } catch (e) { /* 노선 하나 실패는 무시 */ }
      return { stationCd: code, lineNum: r.LINE_NUM || "", trains };
    }));

    return res.status(200).json({ name, week, inout, lines });
  } catch (e) {
    return res.status(502).json({ code: "ERROR-UPSTREAM", message: `시간표 호출 실패: ${(e && e.cause && e.cause.code) || (e && e.message) || e}` });
  }
};
