/* Vercel 서버리스 프록시: 공공데이터포털(data.go.kr) "서울교통공사_빠른하차정보" (제공기관 코드 B553766).
   PROBE 모드: path 파라미터로 임의 경로를 시험 호출(엔드포인트 탐색용, 그대로 유지).
   FINAL 모드: path 파라미터가 없으면 확정된 엔드포인트 GET /inout/getFstExit 를 line/station으로 호출.
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

/* raw 키로 먼저 호출하고, "미등록 키" 응답이면 encoded 키로 한 번 더 재시도.
   buildUrlForKey(keyValue) => 호출할 전체 URL. PROBE/FINAL 모드가 공유하는 헬퍼. */
async function fetchWithKeyFallback(buildUrlForKey) {
  let keyMode = "raw";
  let url = buildUrlForKey(keyMode);
  let result = await fetchWithTimeout(url);

  if (looksLikeBadKey(result.text)) {
    keyMode = "encoded";
    url = buildUrlForKey(keyMode);
    result = await fetchWithTimeout(url);
  }

  return { keyMode, url, result };
}

/* FINAL 모드: GET /inout/getFstExit — lineNm/stnNm 은 포함(부분) 매칭 검색어 */
function buildFinalUrl(line, station, keyMode, KEY) {
  const keyValue = keyMode === "encoded" ? encodeURIComponent(KEY) : KEY;
  const qs = `dataType=JSON&pageNo=1&numOfRows=200&lineNm=${encodeURIComponent(line)}&stnNm=${encodeURIComponent(station)}`;
  return `${BASE}/inout/getFstExit?serviceKey=${keyValue}&${qs}`;
}

/* 응답의 body.items.item 은 0건이면 누락, 1건이면 object, 여러 건이면 array로 온다 */
function normalizeItems(items) {
  if (!items) return [];
  const item = items.item;
  if (item == null) return [];
  return Array.isArray(item) ? item : [item];
}

module.exports = async (req, res) => {
  const KEY = process.env.DATAGO_API_KEY;
  if (!KEY) {
    return res.status(500).json({ code: "ERROR-ENV", message: "DATAGO_API_KEY가 설정되지 않았습니다." });
  }

  const pathParam = req.query && req.query.path;

  /* FINAL 모드: path 파라미터가 없으면 확정 엔드포인트(line/station 검색) 호출 */
  if (!pathParam) {
    res.setHeader("Cache-Control", "no-store");

    const lineRaw = req.query && req.query.line;
    const stationRaw = req.query && req.query.station;
    const line = lineRaw === undefined ? "" : String(lineRaw);
    const station = stationRaw === undefined ? "" : String(stationRaw);
    if (!line || !station || line.length > 20 || station.length > 20) {
      return res.status(400).json({ code: "ERROR-PARAM", message: "line, station 값이 올바르지 않습니다." });
    }

    try {
      const { url, result } = await fetchWithKeyFallback(keyMode => buildFinalUrl(line, station, keyMode, KEY));

      if (looksLikeBadKey(result.text)) {
        return res.status(502).json({ code: "ERROR-KEY", message: "인증키가 아직 활성화되지 않았거나 잘못되었습니다." });
      }

      let parsed;
      try {
        parsed = JSON.parse(result.text);
      } catch (e) {
        return res.status(502).json({ code: "ERROR-UPSTREAM", message: redact("빠른하차정보 응답을 해석할 수 없습니다.", KEY) });
      }

      /* 실제 응답은 { response: { header, body } } 로 감싸져 있음 */
      const root = (parsed && parsed.response) || parsed || {};
      const header = (root && root.header) || {};
      const resultCode = header.resultCode;
      const okCode = resultCode === undefined || resultCode === "00" || resultCode === 0;
      if (!result.ok || !okCode) {
        const message = redact(header.resultMsg || `빠른하차정보 호출 실패 (status ${result.status})`, KEY);
        return res.status(502).json({ code: "ERROR-UPSTREAM", message });
      }

      const norm = s => String(s == null ? "" : s).trim().replace(/\(.*?\)/g, "").replace(/역$/, "");
      const body = (root && root.body) || {};
      const rawItems = normalizeItems(body.items).filter(it =>
        it && typeof it.stnNm === "string" &&
        norm(it.stnNm) === norm(station) &&
        String(it.lineNm || "").includes(line)
      );
      const items = rawItems.map(it => ({
        line: it.lineNm || "",
        station: it.stnNm || "",
        stnCd: it.stnCd || "",
        door: it.qckgffVhclDoorNo || "",
        updn: it.upbdnbSe || "",
        dir: it.drtnInfo || "",
        fac: it.plfmCmgFac || "",
        facPos: it.facPstnNm || "",
        fwk: it.fwkPstnNm || "",
      }));

      res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
      return res.status(200).json({ ok: true, station, line, items });
    } catch (e) {
      const message = redact(`빠른하차정보 호출 실패: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`, KEY);
      return res.status(502).json({ code: "ERROR-UPSTREAM", message });
    }
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

  try {
    const { keyMode, url, result } = await fetchWithKeyFallback(km => buildUrl(path, q, km === "encoded" ? encodeURIComponent(KEY) : KEY));

    return res.status(200).json({
      ok: result.ok,
      status: result.status,
      keyMode,
      /* 키 진단(값은 절대 노출하지 않음): 길이·앞뒤 공백·인코딩 형태 힌트 */
      keyInfo: { len: KEY.length, trimmedLen: KEY.trim().length, hasWhitespace: /\s/.test(KEY),
                 hasPercent: KEY.includes("%"), hasPlus: KEY.includes("+"), hasSlash: KEY.includes("/"), hasEquals: KEY.includes("=") },
      url: redact(url, KEY),
      contentType: result.contentType,
      body: parseBody(result.text)
    });
  } catch (e) {
    const message = redact(`빠른하차정보 프로브 호출 실패: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`, KEY);
    return res.status(502).json({ code: "ERROR-UPSTREAM", message });
  }
};
