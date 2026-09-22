-- 라이브 액티비티(주행 안내) 푸시 — Supabase SQL Editor 에서 한 번 실행.
-- 서버(api/la.js)만 service_role 키로 접근한다. 앱은 절대 이 테이블에 직접 붙지 않는다.

create table if not exists public.ssl_live_trips (
  trip_id       text primary key,          -- 앱이 만든 주행 식별자(UUID 등)
  token         text not null,             -- ActivityKit push token (pushType: .token)
  env           text not null default 'prod',   -- 'prod' | 'sandbox' (개발 빌드는 sandbox)
  attrs         jsonb not null default '{}'::jsonb,   -- TripAttributes {from, to, transfers}
  state         jsonb not null default '{}'::jsonb,   -- 마지막으로 보낸 ContentState
  track         jsonb,                     -- 추적 중인 열차 {no,line,legIdx,stations,legTo,isLast,laterMin,dest,legs,stops,approach}
  paused        boolean not null default false,  -- 앱이 포그라운드라 스스로 갱신 중이면 true
  last_push_at  timestamptz,
  last_feed_at  timestamptz,
  expires_at    timestamptz not null default now() + interval '3 hours',
  updated_at    timestamptz not null default now()
);

alter table public.ssl_live_trips enable row level security;
-- anon 정책 없음: service_role 키(서버)만 읽고 쓴다.

-- 틱이 매번 도는 조건(paused=false and expires_at > now())에 맞춘 인덱스
create index if not exists ssl_live_trips_active_idx
  on public.ssl_live_trips (paused, expires_at);

-- ── pg_cron 스케줄 ─────────────────────────────────────────────────────────
-- 확장(한 번만):
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
-- 'REPLACE_ME' 를 Vercel 의 LA_CRON_SECRET 값과 같게 바꿀 것.

select cron.schedule('ssl-la-tick', '* * * * *', $$
  select net.http_get(
    url:='https://seoul-subway-lyart.vercel.app/api/la?op=tick',
    headers:='{"x-cron-secret":"REPLACE_ME"}'::jsonb
  )
$$);

-- 30초 간격이 필요하면 위 스케줄을 지우고 아래를 쓴다(pg_cron 1.5 이상에서만 동작).
-- select cron.unschedule('ssl-la-tick');
-- select cron.schedule('ssl-la-tick-30s', '30 seconds', $$
--   select net.http_get(
--     url:='https://seoul-subway-lyart.vercel.app/api/la?op=tick',
--     headers:='{"x-cron-secret":"REPLACE_ME"}'::jsonb
--   )
-- $$);

-- 해제:
-- select cron.unschedule('ssl-la-tick');
-- select cron.unschedule('ssl-la-tick-30s');

-- 등록된 작업 확인:
-- select jobid, jobname, schedule, active from cron.job;

-- ── 정리 ───────────────────────────────────────────────────────────────────
-- 만료된 주행 행 삭제(틱은 만료 행을 읽지 않지만 쌓이지 않게 치운다).
delete from public.ssl_live_trips where expires_at < now();

-- 매시 정각 자동 정리를 원하면:
-- select cron.schedule('ssl-la-cleanup', '7 * * * *',
--   $$ delete from public.ssl_live_trips where expires_at < now() $$);

-- ── 점검 ───────────────────────────────────────────────────────────────────
-- 크론이 실제로 호출했는지(응답 코드/본문):
-- select id, status_code, left(content, 300) as body, created
--   from net._http_response order by created desc limit 20;
-- 크론 실행 이력:
-- select jobid, status, return_message, start_time
--   from cron.job_run_details order by start_time desc limit 20;
