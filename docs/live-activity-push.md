# 라이브 액티비티 푸시(APNs) — 운영 메모

주행 안내 라이브 액티비티를 **서버가** 갱신한다. 앱이 `UIBackgroundModes: location` 으로
백그라운드에서 열차를 폴링하던 방식(App Review 거절 사유)을 대체한다.

```
앱  ── 액티비티 시작(pushType: .token) ──▶ push token
    ── POST /api/la?op=register {tripId, token, env, attrs, state, track} ──▶ Supabase ssl_live_trips
Supabase pg_cron (1분) ── GET /api/la?op=tick (x-cron-secret) ──▶ Vercel
    서버가 서울 실시간 위치 피드로 열차를 따라가며 ActivityKit 업데이트를 푸시
```

## 파일

| 파일 | 역할 |
| --- | --- |
| `api/la.js` | register / update / end / tick 한 함수 (op 라우팅) |
| `lib/trip-state.js` | 상태 머신 (Swift `bgPoll`/`bgApply` 이식) |
| `lib/la-core.js` | 틱 1행 계산 — 다음 상태 + 보낼 푸시 결정 (순수 함수) |
| `lib/apns.js` | ES256 JWT + HTTP/2 전송 |
| `lib/supabase.js` | REST(service_role) 헬퍼 |
| `lib/position-feed.js` | 실시간 위치 피드 (`api/position.js` 와 공유) |
| `db/live_activity.sql` | 테이블 + 인덱스 + pg_cron |
| `tests/la.test.mjs` | `node --test tests/la.test.mjs` |

> `lib/` 는 `api/` 밖이라 Vercel 이 서버리스 함수로 배포하지 않는다(번들에는 포함).

## 1. Vercel 환경변수

Project → Settings → Environment Variables (Production + Preview):

| 이름 | 값 |
| --- | --- |
| `APNS_KEY` | `AuthKey_XXXXXXXXXX.p8` 파일 **내용 전체** (`-----BEGIN PRIVATE KEY-----` 포함). 줄바꿈은 실제 개행 또는 `\n` 둘 다 됨 |
| `APNS_KEY_ID` | 그 키의 10자리 Key ID |
| `APNS_TEAM_ID` | `P7ZN2XXS75` |
| `APNS_BUNDLE_ID` | `com.sehyunko.SeoulSubwayLive` (코드가 `.push-type.liveactivity` 를 붙인다 — 여기엔 붙이지 말 것) |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role 키 (**서버 전용**) |
| `LA_CRON_SECRET` | 임의의 긴 문자열 — 틱 인증용 |
| `SUBWAY_API_KEY` | 이미 설정돼 있음 |

`env` 는 행마다 저장한다: Xcode 디버그 빌드 = `"sandbox"`, TestFlight/App Store = `"prod"`.
잘못 넣으면 APNs 가 `BadDeviceToken` 을 돌려주고 서버가 그 행을 지운다.

## 2. Supabase

SQL Editor 에서 `db/live_activity.sql` 실행. 그 전에 확장이 필요하다:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

파일 안의 `REPLACE_ME` 를 `LA_CRON_SECRET` 값으로 바꾼 뒤 `cron.schedule(...)` 을 실행한다.
30초 간격이 필요하면 주석 처리된 `'30 seconds'` 버전을 쓴다(pg_cron 1.5 이상).

테이블 `ssl_live_trips` 는 RLS 를 켜고 anon 정책을 주지 않는다 — 서버(service_role)만 접근한다.

## 3. 앱이 부르는 API

```
POST /api/la?op=register
{ "tripId":"<uuid>", "token":"<activity push token hex>", "env":"prod",
  "attrs":{"from":"광화문","to":"건대입구","transfers":1},
  "state":{ …TripAttributes.ContentState 그대로… },
  "track":{ …웹의 tripTrackPayload() 그대로… } | null,
  "paused":true }

POST /api/la?op=update   // 부분 허용: token/state/track/paused 만 보내도 됨
POST /api/la?op=end      // {"tripId":"…","local":true}  local:true 면 푸시 없이 행만 삭제
```

- 앱이 **포그라운드**일 땐 `paused:true` — 앱이 직접 액티비티를 갱신하므로 서버는 건너뛴다.
- 백그라운드로 갈 때 `paused:false` + 최신 `state`/`track` 을 `op=update` 로 보낸다.
- `op=update` 는 행 수명(`expires_at`)을 3시간 뒤로 연장한다. 앱이 죽어도 3시간이면 멈춘다.
- `track` 이 `null` 이면(아직 탈 열차 미선택) 서버는 상태를 그대로 두고 아무것도 보내지 않는다.

`content-state` 의 키는 `TripActivity/TripAttributes.swift` 의 `ContentState` 와 **정확히** 같아야 한다
(다르면 iOS 가 조용히 무시한다). 테스트가 이 키 집합을 검사한다.

## 4. 확인

```bash
# 계산만(푸시·DB 쓰기 없음) — 지금 추적 중인 행들의 다음 상태를 그대로 보여준다
curl -s -H "x-cron-secret: $LA_CRON_SECRET" \
  "https://seoul-subway-lyart.vercel.app/api/la?op=tick&dry=1" | jq

# 실제 틱
curl -s -H "x-cron-secret: $LA_CRON_SECRET" \
  "https://seoul-subway-lyart.vercel.app/api/la?op=tick"
# → {"rows":3,"pushed":2,"ended":0,"errors":0}

# 시크릿 없이 → 401
curl -s -o /dev/null -w '%{http_code}\n' "https://seoul-subway-lyart.vercel.app/api/la?op=tick"
```

`errors` 는 APNs 가 200 이 아닌 경우의 수다. 자세한 이유(`BadDeviceToken`, `TooManyRequests` 등)는
Vercel → Logs 에 `[la] push fail <tripId> <status> <reason>` 으로 찍힌다.

크론이 실제로 호출했는지는 Supabase SQL Editor 에서:

```sql
select id, status_code, left(content, 300) as body, created
  from net._http_response order by created desc limit 20;

select jobid, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

`status_code` 가 401 이면 `REPLACE_ME` 를 안 바꾼 것이고, 200 인데 `rows:0` 이면 활성 주행이 없거나
모든 행이 `paused=true` 다.

## 5. 푸시 규칙(요약)

- 내용이 바뀌었거나 마지막 푸시로부터 60초가 지나면 보낸다(잠금화면 stale 방지).
- `apns-priority`: 하차/도착/대기 전환은 `10`, 나머지는 `5`. `apns-expiration: 0`.
- `alert` 는 두 경우에만: 하차 전환(`곧 내리세요`), 최종 도착(`목적지 도착`).
- 최종 도착 → `event:"end"` + `dismissal-date` = now+8초, 행 삭제.
- APNs `410`/`BadDeviceToken`/`Unregistered` → 그 행 삭제.
- 한 틱에서 최대 50행, 노선별로 피드를 1회만 받아 병렬 처리한다.

## 6. 아직 남은 것 (앱 쪽)

환승 자동 승차는 **다음 구간의 역 목록**이 있어야 방향을 판정할 수 있다.
현재 웹의 `tripTrackPayload()` 는 `legs` 에 `{line, to, min}` 만 담는다.
`legs[i].stations` 를 함께 보내면 서버가 환승 3분 뒤 다음 열차를 자동으로 잡는다.
없으면 서버는 추측하지 않고 '대기 중' 상태를 유지한다(앱을 열면 기존대로 사용자가 고른다).
