// Showcase view tracker — zero-dependency Vercel serverless function.
// Beacon from each prospect showcase hits /api/track. We log the view to
// Supabase (for the dashboard) and fire an instant alert (Telegram + email)
// when a real human engages with a page.
//
// Env vars (set in the Vercel project for 780marketing.ca):
//   SUPABASE_URL             e.g. https://xxxx.supabase.co   (optional — enables the dashboard/log)
//   SUPABASE_SERVICE_KEY     service-role key                 (optional — paired with SUPABASE_URL)
//   TELEGRAM_BOT_TOKEN       bot token                        (optional — enables Telegram alerts)
//   TELEGRAM_CHAT_ID         your chat id                     (optional — paired with the token)
//   RESEND_API_KEY           re_...                           (optional — enables email alerts)
//   ALERT_EMAIL              where alerts go                  (optional — paired with RESEND_API_KEY)
//   ALERT_FROM_EMAIL         verified Resend sender           (optional — defaults to onboarding@resend.dev)
//   MUTE_IPS                 my IPs / prefixes, comma-sep     (optional — those hits are dropped entirely)
//   MUTE_LOCATIONS           my towns, ";"-separated          (optional — defaults to Okotoks + Edmonton, AB;
//                                                              those hits are logged but never alerted)
//
// Nothing is required for the endpoint to return 200; missing config just
// disables that piece. This keeps a broken env var from ever blocking a page.

const BOT_RE = /bot|crawler|spider|crawl|facebookexternalhit|whatsapp|slackbot|telegrambot|linkedinbot|discordbot|twitterbot|google-read-aloud|bingpreview|preview|pinterest|redditbot|embedly|applebot|headlesschrome|phantom|python-requests|axios|curl|wget|go-http|node-fetch|lighthouse|gtmetrix|pingdom|uptimerobot/i;

// A view is treated as "mine" — never logged, never alerted — if ANY of:
//   1. the visitor's IP matches an entry in the MUTE_IPS env var (comma-separated), or
//   2. the page URL carries a mute flag: ?self  (also #self / ?mute / ?780self), or
//   3. the browser carries the mute cookie we set the first time it used ?self.
// The URL flag works from any device/network with no redeploy, because the
// beacon already forwards the full location.href to us as `u`. The value is
// optional, so ?self, ?self=1 and #self all count.
const SELF_RE = /[?&#](self|mute|780self)(=[^&#]*)?(?=[&#]|$)/i;

// Views from my own town are treated as mine for ALERTING only: they are still
// logged (so a real prospect who happens to sit in the same town is never lost
// — the dashboard just files the hit under "my views"), but they never ping my
// phone. Vercel hands us the geo headers for free, so this costs nothing, needs
// no extra service, and covers every device and network at that location —
// unlike MUTE_IPS (breaks when the ISP rotates the address) or the ?self cookie
// (covers only the one browser that used the flag).
//
// MUTE_LOCATIONS format — entries separated by ";" or newlines, each entry
// "City", "City, Region" or "City, Region, Country" ("/" works instead of the
// comma). "*" wildcards a part, so "*, AB" mutes all of Alberta. Region is the
// short code Vercel sends ("AB"), country is the 2-letter code ("CA").
// Set the env var to "none" to turn location muting off entirely.
const DEFAULT_MUTE_LOCATIONS = "Okotoks, AB, CA; Edmonton, AB, CA";

function firstStr(v) { return Array.isArray(v) ? v[0] : v; }

function norm(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

// x-vercel-ip-country-region is documented as the bare ISO 3166-2 subdivision
// ("AB"), but some edges send it country-prefixed ("CA-AB"). Accept either so a
// header-format change can't quietly switch my own alerts back on.
function normRegion(v) { return norm(v).split("-").pop(); }

function geoMuted(city, region, country) {
  const raw = process.env.MUTE_LOCATIONS;
  const spec = raw && raw.trim() ? raw : DEFAULT_MUTE_LOCATIONS;
  if (norm(spec) === "none" || norm(spec) === "off") return false;
  // An absent geo header (norm → "") can never equal a configured value, so a
  // hit we can't place stays un-muted and still alerts. Fail toward noticing.
  const have = [norm(city), normRegion(region), norm(country)];
  return spec
    .split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
    .some((entry) => {
      const parts = entry.split(/[,/]/).map(norm).filter(Boolean);
      if (!parts.length || parts.length > have.length) return false;
      return parts.every((want, i) => want === "*" || want === have[i]);
    });
}

// Match the visitor IP against MUTE_IPS. Each entry is either an exact IP, or a
// prefix ending in "." or "*" — so "73.15." (or "73.15.*") mutes any 73.15.x.y.
// The prefix form lets a home/office IP whose last octet drifts stay muted.
function ipMuted(ip) {
  if (!ip) return false;
  const list = (process.env.MUTE_IPS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    if (entry.endsWith("*")) {
      if (ip.startsWith(entry.slice(0, -1))) return true;
    } else if (entry.endsWith(".")) {
      if (ip.startsWith(entry)) return true;
    } else if (ip === entry) {
      return true;
    }
  }
  return false;
}

// Once a browser has visited with ?self, we drop a cookie on the tracker's own
// domain. Every later beacon carries it back, so that browser stays muted on
// every showcase without having to append ?self again.
//
// Scoped to .780marketing.ca (not just this exact host) because showcases now
// live at packages.780marketing.ca — same registrable domain as the collector,
// so the browser treats the beacon as SAME-SITE and the cookie survives the
// third-party-cookie blocking that made this unreliable back when showcases
// were on *.surge.sh. It also spans apex → www (the apex 307-redirects to www).
// On any other host (e.g. a *.vercel.app preview) we omit Domain — a browser
// rejects a cookie domain it isn't under, which would silently drop the mute.
function hasMuteCookie(req) {
  return /(?:^|;\s*)s780=1(?:;|$)/.test(req.headers.cookie || "");
}

function muteCookie(req) {
  const host = String(firstStr(req.headers["x-forwarded-host"]) || req.headers.host || "")
    .split(":")[0].toLowerCase();
  const scoped = host === "780marketing.ca" || host.endsWith(".780marketing.ca");
  return "s780=1; Max-Age=31536000; Path=/" +
    (scoped ? "; Domain=.780marketing.ca" : "") +
    "; SameSite=None; Secure";
}

function urlSelf(pageUrl) { return !!pageUrl && SELF_RE.test(pageUrl); }

function isMuted(req, ip, pageUrl) {
  return ipMuted(ip) || urlSelf(pageUrl) || hasMuteCookie(req);
}

module.exports = async function handler(req, res) {
  // CORS — showcases live on *.surge.sh, a different origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};
  const slug = (firstStr(q.slug) || "unknown").slice(0, 120);
  const name = (firstStr(q.name) || slug).slice(0, 160);
  const ev = (firstStr(q.ev) || "load").slice(0, 20);          // "load" | "engaged"
  const vertical = (firstStr(q.v) || "").slice(0, 120);
  const ref = (firstStr(q.ref) || "").slice(0, 400);
  const pageUrl = (firstStr(q.u) || "").slice(0, 400);
  const visitId = (firstStr(q.vid) || "").slice(0, 60);

  const ua = req.headers["user-agent"] || "";
  const isBot = BOT_RE.test(ua);
  const ip = (firstStr(req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  const country = req.headers["x-vercel-ip-country"] || "";
  const region = req.headers["x-vercel-ip-country-region"] || "";
  let city = req.headers["x-vercel-ip-city"] || "";
  try { city = decodeURIComponent(city); } catch (e) { /* leave as-is */ }
  const nowIso = new Date().toISOString();

  const row = {
    slug, name, vertical, event: ev, referrer: ref, page_url: pageUrl,
    visit_id: visitId, ip, user_agent: ua.slice(0, 400),
    country, region, city, is_bot: isBot, created_at: nowIso,
  };

  // My own views — skip logging AND alerting entirely, then return the pixel.
  // Nothing about the showcase changes; it just doesn't "register" my visit.
  if (isMuted(req, ip, pageUrl)) {
    // First time this browser used ?self, remember it so future visits to any
    // showcase are muted automatically (1-year first-party cookie on this origin).
    if (urlSelf(pageUrl)) {
      res.setHeader("Set-Cookie", muteCookie(req));
    }
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.status(200).send(gif);
    return;
  }

  // Persist (fire-and-forget so logging never blocks the response)
  logToSupabase(row).catch(() => {});

  // Alert only on a genuine engaged view from a human — cuts prefetch/scanner noise.
  // (Scanners generally don't run JS at all, so 'engaged' rarely fires for them; the
  //  bot check + event gate are belt-and-suspenders.)
  // NOTE: we AWAIT the alert before responding. On Vercel the function can freeze the
  // instant the response is sent, killing any un-awaited background fetch — a
  // fire-and-forget notify() would silently never deliver. The try/catch keeps a
  // failed alert from ever turning into a non-200 that breaks the showcase.
  // A hit from my own town is logged above but never alerted (see MUTE_LOCATIONS).
  if (ev === "engaged" && !isBot && !geoMuted(city, region, country)) {
    try { await notify(row); } catch (e) { /* never block the pixel */ }
  }

  // Return a 1x1 transparent GIF so an <img> fallback works and nothing renders.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).send(gif);
};

async function logToSupabase(row) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  await fetch(url.replace(/\/$/, "") + "/rest/v1/showcase_views", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

async function notify(row) {
  const where = [row.city, row.region, row.country].filter(Boolean).join(", ");
  const line = `🎥 ${row.name} viewed their showcase — send them a Tella video`;
  // Script path only when we know the vertical (folder = Clients/Prospects/<vertical>/<slug>/)
  const scriptPath = row.vertical
    ? `Clients/Prospects/${row.vertical}/${row.slug}/tella-script.md`
    : "";
  const detail =
    `Prospect: ${row.name} (${row.slug})` +
    (row.vertical ? `\nVertical: ${row.vertical}` : "") +
    (scriptPath ? `\nScript: ${scriptPath}` : "") +
    (where ? `\nLocation: ${where}` : "") +
    (row.referrer ? `\nCame from: ${row.referrer}` : "") +
    (row.page_url ? `\nPage: ${row.page_url}` : "") +
    `\nTime: ${row.created_at}`;

  const jobs = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    jobs.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text: line + "\n\n" + detail, disable_web_page_preview: true }),
    }));
  }

  const resendKey = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL;
  if (resendKey && to) {
    jobs.push(fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || "Showcase Alerts <onboarding@resend.dev>",
        to: [to],
        subject: line,
        text: detail,
      }),
    }));
  }

  await Promise.allSettled(jobs);
}
