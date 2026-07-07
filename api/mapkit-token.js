/* Vercel 서버리스: MapKit JS(애플 지도) 인증 토큰 발급.
   개발자 포털에서 MapKit JS 키(.p8)를 만들고 Vercel 환경변수에 넣으면 동작:
   - MAPKIT_KEY_ID   : 키 ID (예: ABC123DEFG)
   - MAPKIT_TEAM_ID  : 팀 ID (기본 P7ZN2XXS75)
   - MAPKIT_PRIVATE_KEY : .p8 파일 내용 전체(-----BEGIN PRIVATE KEY----- 포함, 줄바꿈은 \n 로 넣어도 됨)
   토큰은 30분 유효, origin 클레임으로 이 도메인에서만 사용 가능. */

const crypto = require("crypto");

module.exports = (req, res) => {
  const kid = process.env.MAPKIT_KEY_ID;
  const iss = process.env.MAPKIT_TEAM_ID || "P7ZN2XXS75";
  const pem = (process.env.MAPKIT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!kid || !pem) {
    return res.status(500).json({ error: "MapKit 키가 설정되지 않았습니다. (MAPKIT_KEY_ID / MAPKIT_PRIVATE_KEY)" });
  }
  try {
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "seoul-subway-lyart.vercel.app");
    const unsigned = b64({ alg: "ES256", kid, typ: "JWT" }) + "." + b64({ iss, iat: now, exp: now + 1800, origin });
    const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: pem, dsaEncoding: "ieee-p1363" }).toString("base64url");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ token: unsigned + "." + sig });
  } catch (e) {
    return res.status(500).json({ error: "토큰 서명 실패: " + (e && e.message) });
  }
};
