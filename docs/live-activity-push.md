# 라이브 액티비티 푸시(APNs) — 운영 메모

주행 안내 라이브 액티비티를 **서버가** 갱신한다. 앱이 `UIBackgroundModes: location` 으로
백그라운드에서 열차를 폴링하던 방식(App Review 거절 사유)을 대체한다.

**설정에 SQL 실행도, 크론 등록도 필요 없다.** Vercel 환경변수만 넣으면 된다.

```
앱  ── 액티비티 시작(pushType: .token) ──▶ push token
    ── POST /api/la?op=register {tripId, token, env, attrs, state, track} ──▶ sf_cache 행 1개
    └─ 서버가 체인 시작: /api/la?op=tick&chain=1
         틱: 서울 실시간 위치 피드로 열차 추적 → ActivityKit 푸시
         → ~50초 기다렸다가 자기 자신을 다시 호출 → 활성 주행이 없어지면 멈춤
```

## 파일

| 파일 | 역할 |
| --- | --- |
| `api/la.js` | register / update / end / tick / kick / cleanup / diag 한 함수 (op 라우팅) + 자기 호출 체인 |
| `lib/trip-state.js` | 상태 머신 (Swift `bgPoll`/`bgApply` 이식) |
| `lib/la-core.js` | 틱 1행 계산 — 다음 상태 + 보낼 푸시 결정, 만료/지연/방치 정리 판정 (순수 함수) |
| `lib/apns.js` | ES256 JWT + HTTP/2 전송 |
| `lib/supabase.js` | 저장소(sf_cache 매핑) + 체인 잠금 |
| `lib/position-feed.js` | 실시간 위치 피드 (`api/position.js` 와 공유) |
| `db/live_activity.sql` | **선택** — 전용 테이블/pg_cron 경로(안 써도 된다) |
| `tests/la.test.mjs` | `node --test tests/la.test.mjs` |

> `lib/` 는 `api/` 밖이라 Vercel 이 서버리스 함수로 배포하지 않는다(번들에는 포함).

## 1. Vercel 환경변수 (이게 전부다)

Project → Settings → Environment Variables (Production + Preview):

| 이름 | 필수 | 값 |
| --- | :---: | --- |
| `APNS_KEY` | ● | `AuthKey_XXXXXXXXXX.p8` 파일 **내용 전체** (`-----BEGIN PRIVATE KEY-----` 포함). 줄바꿈은 실제 개행 또는 `\n` 둘 다 됨 |
| `APNS_KEY_ID` | ● | 그 키의 10자리 Key ID |
| `APNS_TEAM_ID` | ● | `P7ZN2XXS75` |
| `APNS_BUNDLE_ID` | ● | `com.sehyunko.SeoulSubwayLive` (코드가 `.push-type.liveactivity` 를 붙인다 — 여기엔 붙이지 말 것) |
| `SUPABASE_URL` | ● | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` 또는 `SUPABASE_ANON_KEY` | ● | 둘 중 하나. service 키가 있으면 그걸 먼저 쓴다. 둘 다 없으면 `SUPABASE_ANON_FALLBACK` 을 본다 (키 값은 코드에 없다) |
| `SUBWAY_API_KEY` | ● | 이미 설정돼 있음 |
| `LA_CRON_SECRET` | ○ | 틱 인증용. **넣는 쪽을 권장.** 없으면 `sha256(APNS_KEY_ID + "|" + APNS_TEAM_ID)` 로 유도해 체인이 스스로를 인증한다 |
| `LA_SELF_URL` | ○ | 체인이 호출할 자기 주소. 없으면 `https://$VERCEL_PROJECT_PRODUCTION_URL`, 그것도 없으면 `https://seoul-subway-lyart.vercel.app` |
| `LA_TABLE` | ○ | `ssl_live_trips` 로 두면 `db/live_activity.sql` 의 전용 테이블을 쓴다. 기본은 `sf_cache` |

`env` 는 행마다 저장한다: Xcode 디버그 빌드 = `"sandbox"`, TestFlight/App Store = `"prod"`.
잘못 넣으면 APNs 가 `BadDeviceToken` 을 돌려주고 서버가 그 행을 지운다.

## 2. 저장소 — 기존 `public.sf_cache` 를 그대로 쓴다

새 테이블도, RLS 정책도 만들지 않는다. 그 앱이 쓰던 키/값 캐시 테이블
(`date text pk`, `events jsonb`, `updated_at timestamptz`, anon 이 select/upsert/delete 가능)에
접두사를 붙여 얹는다:

| date | events |
| --- | --- |
| `ssl:la:<tripId>` | `{ tripId, token, env, attrs, state, track, paused, last_push_at, last_feed_at, last_progress_at, expires_at }` |
| `ssl:la:lock` | `{ id, until }` — 체인 잠금 |

**삭제는 소프트 삭제다.** anon 키는 RLS 때문에 `DELETE` 가 `200 []` 로 조용히 무시된다. 그래서
`deleteTrips` 는 `Prefer: return=representation` 으로 먼저 DELETE 해 보고(서비스 키면 실제로 지워진다),
지워지지 않은 행은 `events = {deleted:true, deleted_at}` 로 덮어쓴다 — 목록·조회·정리는 이 행을 없는 것으로 본다.
잠금 해제도 같다: 지워지지 않으면 `{id:null, until:0}` 으로 덮어쓰고, 그건 빈 잠금으로 본다.
소프트 삭제 행은 작아서 그대로 둬도 된다.

접두사 덕에 그 앱의 날짜 행(`2026-09-22`)·라인업 행(`af-lineup-…`)과 섞이지 않는다.
목록 조회는 `GET /rest/v1/sf_cache?date=like.ssl:la:*&select=date,events` 로 받아
`paused=false` / `expires_at > now` 를 JS 에서 거른다.

행 상태 보기 (Supabase SQL Editor):

```sql
select date, events->>'paused' as paused, events->'state' as state
  from sf_cache where date like 'ssl:la:%';
```

찌꺼기 청소는 SQL 로 지우지 말고 `op=cleanup` 을 쓴다 — 행만 지우면 잠금화면 액티비티는 그대로 남는다
(end 푸시를 보내야 사라진다). 아래 5절 참고.

## 3. 스케줄러 — 자기 호출 체인 (+ 외부 하트비트)

Vercel Hobby 에는 분 단위 크론이 없다. 그래서 서버가 스스로를 이어 부른다.

1. `op=register` / `op=update` / `op=end` / `op=kick` 은 **잠금이 비어 있고 할 일(활성 행 또는
   정리 대상 행)이 있을 때만** 새 체인을 띄운다(`<self>/api/la?op=tick&chain=1&cid=<uuid>`).
2. 체인 틱은 `ssl:la:lock` 이 없거나·만료됐거나·자기 `cid` 일 때만 진행한다(중복 체인 방지).
   진행하면 임대를 `now + 75초` 로 갱신하고 **곧바로 `202 {accepted:true}`** 를 돌려준다.
   실제 라운드(정리 → 추적·푸시)와 다음 넘기기는 Vercel `waitUntil` 안에서 돈다.
3. 라운드 뒤 활성 주행이 남아 있으면 호출 시작 기준 50초까지 기다렸다가, 잠금이 아직 내 것인지 보고
   갱신한 뒤 다음 틱을 부른다. 다음 틱의 202 를 받을 때까지(보통 <1초, 1회 4초 상한) `waitUntil` 로
   붙잡아 둔다 — 예전엔 응답 후 함수가 얼어 이 요청이 안 나가는 일이 잦았고, 한 번 끊기면 영원히 멈췄다.
   연결 실패·502/503 은 기한(호출 시작 +55초) 안에서 재시도, 타임아웃은 재시도하지 않는다(중복 방지).
   라운드가 예외로 실패해도 체인은 이어 간다.
4. 활성 주행이 0이면(정리까지 마친 뒤) 잠금을 지우고 체인이 끝난다.
5. **자가 복구** — `GET/POST /api/la?op=kick`(인증 없음). 잠금이 비었고 할 일이 있을 때만 체인을
   띄우고 스스로는 푸시하지 않는다(잠금이 곧 속도 제한). jumo 의 `api/push-cron.js`(pg_cron 2분마다)가
   매번 2초 제한으로 이걸 부른다 — 체인이 끊겨도 최대 ~2분+잠금 잔여(≤75초) 뒤 되살아난다.
6. `chain` 없는 `op=tick` 은 예전처럼 한 번만 동기로 돈다(외부 크론·수동 확인용).

`waitUntil` 은 의존성 없이 `globalThis[Symbol.for("@vercel/request-context")].get().waitUntil` 로 얻는다
(`@vercel/functions` 가 내부에서 하는 일). 없는 환경(로컬)에선 체인 틱이 끝까지 돌고 200 으로 응답한다.

### 매달린 액티비티 정리 (매 라운드, 활성 행이 없어도)

| 조건 | 처리 |
| --- | --- |
| `expires_at` 지남(3시간 무소식) | `event:"end"` + 마지막 상태(`done:false`) + `dismissal-date: now` → 행 삭제 |
| `endEpoch + 4분` 지남 **그리고** 4분간 진척 없음(`last_progress_at`) | `event:"end"` + `done:true, remainMin:0` + `dismissal-date: now+60초` + 알림 "목적지 도착 / {to}에 도착했습니다" → 삭제 |
| `paused:true` 인데 `updated_at` 30분 넘게 지남 | 푸시 없이 삭제(앱 소유) |

`last_progress_at` 은 다음 역·남은 분·대기/하차·열차 번호가 바뀔 때(또는 앱이 state/track 을 보낼 때)만
갱신된다. 열차가 피드에 잡혀 있으면 `endEpoch` 가 매 틱 미래로 다시 계산되므로 이 규칙에 걸리지 않는다.
예전 행(이 필드 없음)은 `last_feed_at` 으로 판단한다. end 푸시가 실패해도 행은 지운다(재시도 루프 방지).

한계: 한 라운드가 ~50초라 갱신 주기는 약 50초다. 더 촘촘히 원하면 `CHAIN_ROUND_MS` 를 줄인다
(호출 횟수가 늘어난다).

## 4. 앱이 부르는 API

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
- 백그라운드로 갈 때 `paused:false` + 최신 `state`/`track` 을 `op=update` 로 보낸다(= 체인 시작).
- `op=register/update` 는 행 수명(`expires_at`)을 3시간 뒤로 연장한다. 앱이 죽어도 3시간이면 멈춘다.
- `track` 이 `null` 이면(아직 탈 열차 미선택) 서버는 상태를 그대로 두고 아무것도 보내지 않는다.

`content-state` 의 키는 `TripActivity/TripAttributes.swift` 의 `ContentState` 와 **정확히** 같아야 한다
(다르면 iOS 가 조용히 무시한다). 테스트가 이 키 집합을 검사한다.

## 5. 확인

```bash
S=<LA_CRON_SECRET>   # 안 넣었다면: node -e 'console.log(require("crypto").createHash("sha256").update(process.env.APNS_KEY_ID+"|"+process.env.APNS_TEAM_ID).digest("hex"))'

# 계산만(푸시·DB 쓰기·체인 없음) — 지금 추적 중인 행들의 다음 상태를 그대로 보여준다
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=tick&dry=1" | jq

# 한 번만 돌리기(체인 없음)
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=tick"
# → {"rows":3,"pushed":2,"ended":0,"errors":0}

# 체인 틱을 직접 띄우기 — 잠금이 비어 있으면 곧바로 202 (라운드는 백그라운드)
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=tick&chain=1" | jq
# → {"accepted":true,"cid":"…"}   (다른 체인이 돌고 있으면 {"skipped":"locked",...})

# 매달린 액티비티 지금 정리(만료/지연 → end 푸시 후 삭제, 방치된 paused → 삭제). dry=1 이면 판정만
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=cleanup&dry=1" | jq
curl -s -X POST -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=cleanup" | jq
# → {"rows":9,"cleaned":9,"pushed":9,"ended":9,"errors":0,"notes":{"expired":9}}

# 체인 자가 복구(인증 없음) — 잠금이 비었고 할 일이 있을 때만 띄운다
curl -s "https://seoul-subway-lyart.vercel.app/api/la?op=kick"
# → {"kicked":true}  |  {"kicked":false,"reason":"locked"|"no-active-rows"}

# 환경 점검(키 값은 안 나온다 — 존재 여부·길이·파싱 성공, Supabase 도달 상태코드만)
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=diag" | jq

# APNs 실제 왕복 점검(기기 토큰 0x64 로 한 번 쏴 본다 — 배달되지 않는다)
curl -s -H "x-cron-secret: $S" "https://seoul-subway-lyart.vercel.app/api/la?op=diag&probe=1" | jq .probe
#   BadDeviceToken            → 키·kid·team·토픽 모두 정상(기기 토큰만 가짜)
#   InvalidProviderToken/403  → APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID 가 틀림
#   TopicDisallowed/400       → APNS_BUNDLE_ID(토픽)가 틀림
#   probeEnv=prod|sandbox 로 한쪽만 볼 수 있다(기본 both)

# 시크릿 없이 → 401
curl -s -o /dev/null -w '%{http_code}\n' "https://seoul-subway-lyart.vercel.app/api/la?op=tick"
```

`errors` 는 APNs 가 200 이 아닌 경우의 수다. 자세한 이유(`BadDeviceToken`, `TooManyRequests` 등)는
Vercel → Logs 에 `[la] push fail <tripId> <status> <reason>` 으로 찍힌다.
체인이 도는지는 Vercel → Logs 에서 `/api/la?op=tick&chain=1` 호출이 ~50초 간격으로 이어지는지,
또는 Supabase 에서 `ssl:la:lock` 의 `updated_at` 이 계속 갱신되는지 보면 된다.
넘기기 실패는 `[la] handoff …`, 라운드 예외는 `[la] round …` 로 찍힌다.

## 6. 푸시 규칙(요약)

- 내용이 바뀌었거나 마지막 푸시로부터 60초가 지나면 보낸다(잠금화면 stale 방지).
- `apns-priority`: 하차/도착/대기 전환은 `10`, 나머지는 `5`. `apns-expiration: 0`.
- `alert` 는 두 경우에만: 하차 전환(`곧 내리세요`), 최종 도착(`목적지 도착`).
- 최종 도착 → `event:"end"` + `dismissal-date` = now+8초, 행 삭제.
- 만료·지연·방치 행 정리는 3절 표 참고.
- APNs `410`/`BadDeviceToken`/`Unregistered` → 그 행 삭제.
- 한 틱에서 최대 50행, 노선별로 피드를 1회만 받아 병렬 처리한다.

## 7. 앱 쪽 연동 상태

- 웹의 `tripTrackPayload()` 는 `legs[i].stations` 까지 보낸다(커밋 c65b847) — 서버가 환승 3분 뒤
  다음 열차의 **방향을 판정해 자동 승차**할 수 있다. 방향이 불확실하면(종착역이 다음 구간 역
  목록 밖) 추측하지 않고 '대기 중'을 유지한다.
- 남은 것은 iOS 쪽: 액티비티를 `pushType: .token` 으로 시작하고, 토큰을 받는 즉시
  `op=register` 를 부른 뒤 포그라운드/백그라운드 전환마다 `op=update` 로 `paused` 를 토글한다.
  안내를 끝낼 땐 `op=end`(앱이 직접 액티비티를 닫았으면 `local:true`).
  `UIBackgroundModes: location` 과 `bgPoll`/`bgTimer` 는 이 경로가 붙으면 제거할 수 있다.
