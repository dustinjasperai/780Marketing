// Read API for the showcase-views dashboard. Guarded by a shared secret so the
// log isn't public. Call as /api/views?key=YOUR_DASHBOARD_KEY
//
// Env vars:
//   DASHBOARD_KEY            required — the shared secret the dashboard sends
//   SUPABASE_URL             required
//   SUPABASE_SERVICE_KEY     required
//   MUTE_LOCATIONS           optional — my towns; hits from them get self_view:true
//                            so the dashboard can hide them. Same var and format
//                            as api/track.js (which uses it to skip the alert).

function firstStr(v) { return Array.isArray(v) ? v[0] : v; }

// Kept in sync with api/track.js on purpose — these are zero-dependency
// standalone functions with no shared module, but they read the SAME env var,
// so MUTE_LOCATIONS stays the single place you configure this.
const DEFAULT_MUTE_LOCATIONS = "Okotoks, AB, CA; Edmonton, AB, CA";

function norm(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
function normRegion(v) { return norm(v).split("-").pop(); }  // "CA-AB" → "ab"

function geoMuted(city, region, country) {
  const raw = process.env.MUTE_LOCATIONS;
  const spec = raw && raw.trim() ? raw : DEFAULT_MUTE_LOCATIONS;
  if (norm(spec) === "none" || norm(spec) === "off") return false;
  const have = [norm(city), normRegion(region), norm(country)];
  return spec
    .split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
    .some((entry) => {
      const parts = entry.split(/[,/]/).map(norm).filter(Boolean);
      if (!parts.length || parts.length > have.length) return false;
      return parts.every((want, i) => want === "*" || want === have[i]);
    });
}

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
    // Tag my-location hits so the dashboard can hide them without needing a new
    // Supabase column (nothing has to be migrated, and history re-tags itself if
    // MUTE_LOCATIONS ever changes).
    const tagged = (Array.isArray(rows) ? rows : []).map((v) => Object.assign({}, v, {
      self_view: geoMuted(v.city, v.region, v.country),
    }));
    res.status(200).json({ rows: tagged });
  } catch (e) {
    res.status(502).json({ error: "fetch failed" });
  }
};
