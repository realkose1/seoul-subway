/* Vercel 서버리스 프록시: 공공데이터포털(data.go.kr) "서울교통공사_빠른하차정보" (제공기관 코드 B553766).
   정확한 엔드포인트 경로/파라미터명이 아직 확정되지 않아, 우선 임의 경로를 시험 호출할 수 있는
   PROBE 모드를 제공한다. 최종 경로가 확정되면 FINAL 모드를 구현한다.
   키: DATAGO_API_KEY. serviceKey는 raw(그대로)로 먼저 시도하고, "미등록 키" 응답이 오면
   encodeURIComponent 인코딩된 키로 한 번 더 재시도한다 (공공데이터포털 키가 raw/encoded 두 형태로
   저장되어 있을 때 둘 다 대응하기 위함). */

const BASE = "https://apis.data.go.kr/B553766";
const PATH_RE = /^[A-Za-z0-9_\-\/.]{1,120}$/;
const Q_RE = /^[A-Za-z0-9_\-=&%.+]*$/;

function redact(str, key) {
  if (!str || !key) return str;
  let out = String(str);
  for (const v of [key, encodeURIComponent(key)]) {
    if (v) out = out.split(v).join("***");
  }
  return out;
}

function buildUrl(path, q, keyValue) {
  let url = `${BASE}/${path}?serviceKey=${keyValue}`;
  if (q) url += `&${q}`;
  const hasType = q.includes("_type=") || q.includes("type=");
  if (!hasType) url += "&_type=json";
  return url;
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, ok: r.ok, contentType: r.headers.get("content-type") || "", text };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeBadKey(text) {
  if (!text) return false;
  return (
    text.includes("SERVICE_KEY_IS_NOT_REGISTERED") ||
    text.includes("SERVICE KEY IS NOT REGISTERED") ||
    text.includes('"resultCode":"30"') ||
    text.includes("<resultCode>30</resultCode>")
  );
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return String(text).slice(0, 20000);
  }
}

module.exports = async (req, res) => {
  const KEY = process.env.DATAGO_API_KEY;
  if (!KEY) {
    return res.status(500).json({ code: "ERROR-ENV", message: "DATAGO_API_KEY가 설정되지 않았습니다." });
  }

  const pathParam = req.query && req.query.path;

  /* FINAL 모드: path 파라미터가 없으면 아직 확정된 엔드포인트가 없다는 뜻 */
  if (!pathParam) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(501).json({ code: "NOT_READY", message: "엔드포인트 확정 전" });
  }

  /* PROBE 모드 */
  res.setHeader("Cache-Control", "no-store");

  const path = String(pathParam);
  if (!PATH_RE.test(path) || path.includes("..")) {
    return res.status(400).json({ code: "ERROR-PARAM", message: "path 값이 올바르지 않습니다." });
  }

  const qRaw = req.query.q;
  const q = qRaw === undefined ? "" : String(qRaw);
  if (q.length > 500 || !Q_RE.test(q)) {
    return res.status(400).json({ code: "ERROR-PARAM", message: "q 값이 올바르지 않습니다." });
  }

  let keyMode = "raw";
  let url = buildUrl(path, q, KEY);

  try {
    let result = await fetchWithTimeout(url);

    if (looksLikeBadKey(result.text)) {
      keyMode = "encoded";
      url = buildUrl(path, q, encodeURIComponent(KEY));
      result = await fetchWithTimeout(url);
    }

    return res.status(200).json({
      ok: result.ok,
      status: result.status,
      keyMode,
      url: redact(url, KEY),
      contentType: result.contentType,
      body: parseBody(result.text)
    });
  } catch (e) {
    const message = redact(`빠른하차정보 프로브 호출 실패: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`, KEY);
    return res.status(502).json({ code: "ERROR-UPSTREAM", message });
  }
};
