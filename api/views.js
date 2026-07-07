// Read API for the showcase-views dashboard. Guarded by a shared secret so the
// log isn't public. Call as /api/views?key=YOUR_DASHBOARD_KEY
//
// Env vars:
//   DASHBOARD_KEY            required — the shared secret the dashboard sends
//   SUPABASE_URL             required
//   SUPABASE_SERVICE_KEY     required

function firstStr(v) { return Array.isArray(v) ? v[0] : v; }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const key = firstStr((req.query || {}).key) || "";
  const expected = process.env.DASHBOARD_KEY || "";
  if (!expected || key !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const url = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !sk) {
    res.status(500).json({ error: "supabase not configured" });
    return;
  }

  const limit = Math.min(parseInt(firstStr((req.query || {}).limit) || "500", 10) || 500, 2000);
  const endpoint = url.replace(/\/$/, "") +
    "/rest/v1/showcase_views?select=*&order=created_at.desc&limit=" + limit;

  try {
    const r = await fetch(endpoint, { headers: { apikey: sk, Authorization: "Bearer " + sk } });
    if (!r.ok) { res.status(502).json({ error: "supabase error", status: r.status }); return; }
    const rows = await r.json();
    res.status(200).json({ rows });
  } catch (e) {
    res.status(502).json({ error: "fetch failed" });
  }
};
