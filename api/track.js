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
//
// Nothing is required for the endpoint to return 200; missing config just
// disables that piece. This keeps a broken env var from ever blocking a page.

const BOT_RE = /bot|crawler|spider|crawl|facebookexternalhit|whatsapp|slackbot|telegrambot|linkedinbot|discordbot|twitterbot|google-read-aloud|bingpreview|preview|pinterest|redditbot|embedly|applebot|headlesschrome|phantom|python-requests|axios|curl|wget|go-http|node-fetch|lighthouse|gtmetrix|pingdom|uptimerobot/i;

function firstStr(v) { return Array.isArray(v) ? v[0] : v; }

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

  // Persist (fire-and-forget so logging never blocks the response)
  logToSupabase(row).catch(() => {});

  // Alert only on a genuine engaged view from a human — cuts prefetch/scanner noise.
  // (Scanners generally don't run JS at all, so 'engaged' rarely fires for them; the
  //  bot check + event gate are belt-and-suspenders.)
  if (ev === "engaged" && !isBot) {
    notify(row).catch(() => {});
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
  const line = `👀 Showcase viewed — ${row.name}`;
  const detail =
    `Prospect: ${row.name} (${row.slug})` +
    (row.vertical ? `\nVertical: ${row.vertical}` : "") +
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
