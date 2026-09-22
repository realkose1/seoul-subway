/* APNs — 토큰 인증(ES256 JWT) + HTTP/2. 라이브 액티비티 갱신/종료 전송 전용.
   jumo(api/push-cron.js)의 sendLiveActivity 와 같은 방식이고, 여기서는
   여러 행을 한 번의 틱에서 보내므로 연결과 JWT를 재사용한다.

   환경변수: APNS_KEY(.p8 PEM 내용), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID */

const http2 = require("http2");
const crypto = require("crypto");

const HOSTS = { prod: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };

/* APNS_KEY 를 붙여넣는 방식이 제각각이라(따옴표째, \n 이스케이프, 헤더 없이 본문만,
   한 줄로 뭉친 본문) 어떤 모양이 와도 표준 PEM 으로 펴 준다. 값은 절대 로그에 찍지 않는다. */
function normalizePem(raw) {
  let s = String(raw == null ? "" : raw).trim();
  /* 셸/대시보드에서 따옴표째 들어온 경우 */
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1).trim();
  s = s.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
  if (!s) return "";

  const wrap = (body, label) => `-----BEGIN ${label}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${label}-----\n`;

  if (!s.includes("-----BEGIN")) {
    /* 헤더 없이 본문만 붙여넣은 경우 — base64 로 보이면 PEM 으로 감싼다 */
    const body = s.replace(/\s+/g, "");
    return /^[A-Za-z0-9+/=]{100,}$/.test(body) ? wrap(body, "PRIVATE KEY") : s;
  }
  /* 헤더는 있는데 본문이 한 줄로 뭉친 경우 — 64자로 다시 접는다 */
  const m = s.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END [^-]+-----/);
  if (!m) return s;
  const body = m[2].replace(/\s+/g, "");
  return body ? wrap(body, m[1].trim()) : s;
}

/* JWT 는 Apple 권고대로 20~60분마다 갱신한다(너무 자주 만들면 TooManyProviderTokenUpdates). */
let jwtCache = { token: null, at: 0 };
function apnsJWT(now = Date.now()) {
  if (jwtCache.token && now - jwtCache.at < 50 * 60 * 1000) return jwtCache.token;
  const key = normalizePem(process.env.APNS_KEY);
  if (!key) throw new Error("APNS_KEY missing");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: process.env.APNS_KEY_ID });
  const body = b64({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  const sig = crypto.sign("SHA256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  const token = `${head}.${body}.${sig.toString("base64url")}`;
  jwtCache = { token, at: now };
  return token;
}

/* 한 요청(틱) 동안 env 별로 HTTP/2 연결을 하나씩 유지한다. */
function createPusher() {
  const clients = new Map();   // env -> ClientHttp2Session
  const client = (env) => {
    const e = env === "sandbox" ? "sandbox" : "prod";
    let c = clients.get(e);
    if (!c || c.closed || c.destroyed) {
      c = http2.connect(`https://${HOSTS[e]}`);
      c.on("error", () => {});   // 연결 오류는 각 요청의 error 핸들러가 받는다
      clients.set(e, c);
    }
    return c;
  };

  /**
   * @param opts {token, env, contentState, event:"update"|"end", priority:5|10,
   *              alert:{title,body}|null, dismissalSec:number|null, staleSec:number}
   * @returns {status, reason, body}
   */
  function send(opts) {
    const {
      token, env = "prod", contentState, event = "update",
      priority = 5, alert = null, dismissalSec = null, staleSec = 3600,
    } = opts;
    const now = Math.floor(Date.now() / 1000);
    const aps = {
      timestamp: now,
      event,
      "content-state": contentState,
      "stale-date": now + Math.max(60, staleSec),
    };
    if (dismissalSec != null) aps["dismissal-date"] = dismissalSec;
    if (alert) aps.alert = { title: alert.title, body: alert.body };

    const jwt = apnsJWT();
    return new Promise((resolve) => {
      let req;
      try {
        req = client(env).request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": `${process.env.APNS_BUNDLE_ID}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": String(priority),
          "apns-expiration": "0",
        });
      } catch (e) {
        return resolve({ status: 0, reason: "connect-failed", body: String(e && e.message) });
      }
      let status = 0, data = "";
      req.setEncoding("utf8");
      req.setTimeout(8000, () => { try { req.close(); } catch (e) {} resolve({ status: 0, reason: "timeout", body: "" }); });
      req.on("response", (h) => { status = h[":status"]; });
      req.on("data", (d) => { data += d; });
      req.on("end", () => {
        let reason = "";
        if (data) { try { reason = JSON.parse(data).reason || ""; } catch (e) { reason = data.slice(0, 120); } }
        resolve({ status, reason, body: data });
      });
      req.on("error", (e) => resolve({ status: 0, reason: "error", body: String(e && e.message) }));
      req.end(JSON.stringify({ aps }));
    });
  }

  const close = () => { for (const c of clients.values()) { try { c.close(); } catch (e) {} } clients.clear(); };
  return { send, close };
}

/* 이 토큰은 더 이상 유효하지 않다 → 행을 지워야 한다 */
const isDeadToken = (r) =>
  r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" ||
  r.reason === "ExpiredToken" || r.reason === "DeviceTokenNotForTopic";

module.exports = { apnsJWT, normalizePem, createPusher, isDeadToken, HOSTS };
