/* Supabase REST (service_role) — jumo/api/push-cron.js 와 같은 방식.
   service key 는 서버에만 있고, 테이블은 RLS 켜고 anon 정책을 주지 않는다. */

const sbHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  "content-type": "application/json",
});

const base = () => `${process.env.SUPABASE_URL}/rest/v1`;

async function sbFetch(path, init) {
  const r = await fetch(`${base()}/${path}`, Object.assign({ headers: sbHeaders() }, init));
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`supabase ${r.status} ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function sbSelect(table, query) {
  const r = await sbFetch(`${table}?${query}`, { method: "GET" });
  return r.json().catch(() => []);
}

/* on_conflict 기준 upsert. 돌려받은 행(표현)을 준다. */
async function sbUpsert(table, rows, onConflict) {
  const r = await sbFetch(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  return r.json().catch(() => []);
}

async function sbPatch(table, query, patch) {
  const r = await sbFetch(`${table}?${query}`, {
    method: "PATCH",
    headers: Object.assign(sbHeaders(), { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  return r.json().catch(() => []);
}

async function sbDelete(table, query) {
  await sbFetch(`${table}?${query}`, { method: "DELETE", headers: sbHeaders() });
}

module.exports = { sbHeaders, sbSelect, sbUpsert, sbPatch, sbDelete };
