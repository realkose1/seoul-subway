/* Vercel 서버리스 프록시: 인증키를 서버에만 두고 실시간 열차 위치를 중계합니다.
   Vercel 대시보드 → Settings → Environment Variables 에 SUBWAY_API_KEY 등록 필요 */

const ALLOWED = new Set(["1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  const key = process.env.SUBWAY_API_KEY;

  /* 프록시 사용 가능 여부 확인용 (상위 API 호출 없음) */
  if (req.query.probe) return res.status(200).json({ ok: !!key });

  if (!key) return res.status(500).json({ code: "ERROR-ENV", message: "서버에 SUBWAY_API_KEY 환경변수가 설정되지 않았습니다." });

  const line = String(req.query.line || "");
  if (!ALLOWED.has(line)) return res.status(400).json({ code: "ERROR-PARAM", message: "지원하지 않는 노선입니다." });

  try {
    const upstream = `https://swopenapi.seoul.go.kr/api/subway/${key}/json/realtimePosition/0/200/${encodeURIComponent(line)}`;
    const r = await fetch(upstream);
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ code: "ERROR-UPSTREAM", message: "실시간 API 호출에 실패했습니다." });
  }
};
