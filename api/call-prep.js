// Call-prep relay for the /call-confirmed page.
//
// The optional prep form there replaced the required Calendly invitee
// questions on the 30 Min Intro event (removed 2026-08-24 after a booking
// drop-off). Answers arrive here AFTER the call is already booked, so a
// failure must never cost a booking — worst case we lose the prep notes.
//
// Zero-dependency Vercel function, same pattern as track.js. Delivers the
// answers as an email via Resend using the env vars already live on this
// project (RESEND_API_KEY, ALERT_EMAIL, ALERT_FROM_EMAIL). Same-origin
// POSTs only — no CORS headers on purpose.

function clean(v, max = 1200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false }); }
  }
  body = body || {};

  // honeypot filled = bot; claim success, send nothing
  if (clean(body.hp)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 150);
  const email = clean(body.email, 200);
  const callTime = clean(body.callTime, 120);
  // Assessment answers. Field set mirrors the discovery framework:
  // situation (business, website, ads) -> problem -> desired outcome (goal).
  const business = clean(body.business);
  const website = clean(body.website, 500);
  const problem = clean(body.problem);
  const ads = clean(body.ads, 120);
  const goal = clean(body.goal);
  // `topics` kept for any cached copy of the old single-question form.
  const topics = clean(body.topics);

  // Nothing to relay — the form is optional, so an empty submit is a no-op.
  if (!business && !website && !problem && !ads && !goal && !topics) {
    return res.status(400).json({ ok: false, error: 'empty' });
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) {
    console.error('call-prep: RESEND_API_KEY / ALERT_EMAIL not set — answers dropped:',
      name, email, (problem || topics).slice(0, 120));
    return res.status(500).json({ ok: false });
  }

  const lines = [
    `Who: ${name || 'not given'} <${email || 'no email'}>`,
    `Call: ${callTime || 'time not passed'}`,
    '',
    'Business (what they sell, who for):',
    business || '—',
    '',
    'Website / funnels:',
    website || '—',
    '',
    'Main problem to solve:',
    problem || topics || '—',
    '',
    `Paid ads history: ${ads || '—'}`,
    '',
    '90-day win:',
    goal || '—',
  ];

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || 'Call Prep <onboarding@resend.dev>',
        to,
        reply_to: email || undefined,
        subject: `📋 Call prep — ${name || email || 'booked call'}`,
        text: lines.join('\n'),
        html: `<pre style="font:14px/1.6 monospace">${esc(lines.join('\n'))}</pre>`,
      }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('call-prep send failed:', String(err.message).slice(0, 300));
    return res.status(502).json({ ok: false });
  }
};
