// "Will my own showcase views alert me?" — open this from any device:
//   https://780marketing.ca/api/whereami
//
// It reports the location VERCEL thinks the request came from (its geo database,
// which is what api/track.js matches against — third-party IP lookups often
// disagree, so this is the only answer that counts) and whether a showcase view
// from here would ping you or stay quiet.
//
// Everyone sees only their own request, and no secret is echoed: the configured
// MUTE_LOCATIONS value is deliberately NOT returned, just the verdict it produced.
//
// Env: MUTE_LOCATIONS / MUTE_IPS — same vars and format as api/track.js.

const DEFAULT_MUTE_LOCATIONS = "Okotoks, AB, CA; Edmonton, AB, CA";

function firstStr(v) { return Array.isArray(v) ? v[0] : v; }
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

function ipMuted(ip) {
  if (!ip) return false;
  return (process.env.MUTE_IPS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .some((entry) => {
      if (entry.endsWith("*")) return ip.startsWith(entry.slice(0, -1));
      if (entry.endsWith(".")) return ip.startsWith(entry);
      return ip === entry;
    });
}

module.exports = async function handler(req, res) {
  const ip = (firstStr(req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  let city = req.headers["x-vercel-ip-city"] || "";
  try { city = decodeURIComponent(city); } catch (e) { /* leave as-is */ }
  const region = req.headers["x-vercel-ip-country-region"] || "";
  const country = req.headers["x-vercel-ip-country"] || "";

  // Ask about a town you are NOT sitting in: /api/whereami?city=Edmonton&region=AB&country=CA
  // This is how you confirm a MUTE_LOCATIONS change actually took effect in
  // production — the deployed default and a Vercel env var can disagree, and
  // without this you'd only find out by waiting for an unwanted alert.
  const q = req.query || {};
  const simCity = firstStr(q.city), simRegion = firstStr(q.region), simCountry = firstStr(q.country);
  const simulated = !!(simCity || simRegion || simCountry);
  const askCity = simulated ? (simCity || "") : city;
  const askRegion = simulated ? (simRegion || "") : region;
  const askCountry = simulated ? (simCountry || "") : country;

  const byLocation = geoMuted(askCity, askRegion, askCountry);
  const byIp = ipMuted(ip);
  const byCookie = /(?:^|;\s*)s780=1(?:;|$)/.test(req.headers.cookie || "");

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const verdict = byLocation || byIp || byCookie ? "stay quiet" : "alert you";
  const out = {
    vercel_sees: { city: city || null, region: region || null, country: country || null, ip: ip || null },
    muted_by: {
      location: byLocation,   // MUTE_LOCATIONS matched → logged, but no alert
      ip: byIp,               // MUTE_IPS matched → not even logged
      self_cookie: byCookie,  // this browser used ?self before → not even logged
    },
    // Plain-language bottom line. If this says "alert" while you're at home, copy
    // the city above into MUTE_LOCATIONS in Vercel — your IP places you elsewhere.
    a_view_from_here_would: verdict,
  };
  // Never let a simulated answer be mistaken for a real one: say so, echo what
  // was asked, and drop the "from here" phrasing (only `location` was simulated —
  // the cookie and IP checks still reflect this actual request).
  if (simulated) {
    delete out.a_view_from_here_would;
    out.simulated_check = { city: askCity || null, region: askRegion || null, country: askCountry || null };
    out.a_view_from_there_would = verdict;
  }
  res.status(200).json(out);
};
