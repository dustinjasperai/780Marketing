// Passive Workforce — Turnkey qualification form relay.
// Zero-dependency Vercel serverless function, same pattern as track.js.
//
// The custom forms on the GHL funnel pages POST here; we upsert the contact
// into the PW sub-account via the GHL v2 API. The browser never sees the
// token, upsert prevents duplicates, and answers + UTM params land as
// custom fields on the contact record.
//
// TWO FORMS SHARE THIS ENDPOINT, distinguished by body.form:
//   (absent) / "registration"  webinar-registration-inline.html   -> /thankyou-1 | /thankyou-2
//   "application"              application-inline.html            -> Calendly (Veronika | Caleb) | /callbooking2-page
// They write different custom fields and different tags but the same
// contact record, so a registrant who later applies is one contact with
// the whole history on it.
//
// Env vars (set in the Vercel project for 780marketing.ca):
//   PW_GHL_TOKEN        Private Integration token for the PW sub-account (required)
//                       Scopes: contacts.write, locations/customFields.readonly,
//                               locations/customFields.write
//   PW_GHL_LOCATION_ID  PW sub-account location id (required)
//   PW_ALLOWED_ORIGINS  comma-sep CORS allowlist (optional — defaults below)
//   TELEGRAM_BOT_TOKEN  reused from the showcase tracker (optional — enables
//   TELEGRAM_CHAT_ID    failure alerts + instant qualified-lead pings)
//   PW_LEAD_ALERTS      "off" disables the qualified-lead Telegram ping (default on)
//
// Custom fields are resolved by NAME against the sub-account on cold start
// and auto-created if missing, so there is no manual field setup and no
// hardcoded field IDs. Missing env vars fail loud (Telegram + 500), but the
// form redirects the visitor regardless — a lead never sees an error.

const GHL = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

const DEFAULT_ORIGINS = [
  'https://workshop.passiveworkforce.com',
  'https://www.passiveworkforce.com',
  'https://passiveworkforce.com',
];

// Contact custom fields.
//
// These resolve to the fields ALREADY BUILT in the PW sub-account's
// "General Info" folder wherever one exists. Resolution is BY KEY first, then
// by name, because two of the existing names are unreliable to match on:
// "Where are you at in the process? " carries a trailing space, and the
// investment field's name is a full sentence.
//
// Anything with `create:true` does not exist yet and the relay may create it.
// Everything else MUST already exist — if the key stops matching we would
// silently start writing into a freshly created duplicate, so those are
// verified rather than created (see VERIFY_ONLY below).
const FIELDS = {
  // --- existing General Info fields (shared by both forms) ---
  agencyType: { key: 'contact.what_type_of_agency_are_you_interested_in',
                name: 'What type of agency are you interested in?' },
  capital:    { key: 'contact.lastly_our_service_covers_building_a_business_from_start_to_finish_it_starts_at_a_5figure_investment_how_much_are_you_willing_to_invest_to_start_a_successful_business',
                name: 'Lastly, our service covers building a business from start to finish. It starts at a 5-figure investment. How much are you willing to invest to start a successful business?' },
  stage:      { key: 'contact.where_are_you_at_in_the_process',
                name: 'Where are you at in the process?' },
  // Registration form's five-figure Yes/No. Built by hand in GHL 2026-08-23,
  // so verify-only like the UTMs — never auto-create a duplicate.
  investment: { key: 'contact.open_to_the_investment',
                name: 'Open to the investment?' },
  state:      { key: 'contact.what_state_are_you_in',
                name: 'What State are you in?' },
  priority:   { key: 'contact.turnkey_priority',
                name: 'Turn-Key Priority' },
  fbClickId:  { key: 'contact.fbc', name: 'Facebook Click ID' },
  fbBrowserId:{ key: 'contact.fbp', name: 'Facebook Browser ID' },

  // --- created once, then live in General Info alongside the rest ---
  timeline:   { key: 'contact.launch_timeline',  name: 'Launch Timeline',  create: true },
  decision:   { key: 'contact.decision_makers',  name: 'Decision Makers',  create: true },
  notes:      { key: 'contact.application_notes', name: 'Application Notes', create: true },
  route:      { key: 'contact.booking_route',    name: 'Booking Route',    create: true },
  // Renamed in GHL 2026-08-23 (key unchanged). Name must track the GHL display
  // name: on a create:true field a stale name means a failed key lookup would
  // CREATE a duplicate instead of falling back to the renamed field.
  session:    { key: 'contact.webinar_session',  name: 'Turnkey Webinar Session',  create: true },

  // --- attribution ---
  // The five UTMs are VERIFY-ONLY (no create) as of 2026-08-20, confirmed live
  // to resolve against existing fields. Auto-creating them was a silent-duplicate
  // hazard: rename one in GHL and the relay would quietly build a replacement and
  // keep reporting success, splitting attribution across two fields.
  utmSource:  { key: 'contact.utm_source',   name: 'UTM Source' },
  utmMedium:  { key: 'contact.utm_medium',   name: 'UTM Medium' },
  utmCampaign:{ key: 'contact.utm_campaign', name: 'UTM Campaign' },
  utmTerm:    { key: 'contact.utm_term',     name: 'UTM Term' },
  utmContent: { key: 'contact.utm_content',  name: 'UTM Content' },
  gclid:      { key: 'contact.google_click_id', name: 'Google Click ID', create: true },
  adId:       { key: 'contact.ad_id',        name: 'Ad ID',        create: true },
  adsetId:    { key: 'contact.adset_id',     name: 'Adset ID',     create: true },
  campaignId: { key: 'contact.ad_campaign_id', name: 'Ad Campaign ID', create: true },
  placement:  { key: 'contact.ad_placement', name: 'Ad Placement', create: true },
  landingPage:{ key: 'contact.landing_page', name: 'Landing Page', create: true },
  referrer:   { key: 'contact.first_referrer', name: 'First Referrer', create: true },
};

// Writing a value a radio field does not offer either fails or stores junk, so
// every radio write goes through these maps. The right-hand strings are the
// EXACT option labels configured in GHL — do not "tidy" them.
const AGENCY_TYPE = {
  'Medical staffing': 'Medical staffing (placing nurses, CNAs, therapists into facilities)',
  'Home care':        "Home care (providing care directly in clients' homes)",
  'Not sure yet':     'Not sure yet',
};

const CAPITAL = {
  'Not in a position to invest a sizable amount': "I'm not in a position to invest a sizable amount in starting a business",
  '$5,000 to $10,000':   '$5-$10k',
  '$10,000 to $15,000':  '$10-$15k',
  '$15,000 to $20,000':  '$15k+',   // collapsed, by decision 2026-08-19
  '$20,000 or more':     '$15k+',   // collapsed, by decision 2026-08-19
};

// Registration form's investment question. The page sends Yes/No verbatim and
// the GHL radio offers exactly those two options.
const INVESTMENT = {
  'Yes': 'Yes',
  'No':  'No',
};

// Turn-Key Priority follows the money, nothing else.
const PRIORITY = {
  '$20,000 or more':    'Priority 1',
  '$15,000 to $20,000': 'Priority 1',
  '$10,000 to $15,000': 'Priority 2',
  '$5,000 to $10,000':  'Priority 3',
  'Not in a position to invest a sizable amount': 'Priority 3',
};

// Application step 4 -> the existing three-option radio.
const STAGE_APP = {
  'Already started and stalled':    'Already started and looking for more help',
  'Operating, want to expand':      'Already started and looking for more help',
  'Ready to start, nothing filed':  'Not yet started but serious about launching',
  'Still researching':              'Just exploring - not committed to launching yet',
};

// Registration form q1 -> the same radio, so both forms agree.
const STAGE_REG = {
  "I've already started and I'm looking for more help":   'Already started and looking for more help',
  "I haven't started yet, but I'm serious about launching":'Not yet started but serious about launching',
  "I'm just researching for now":                          'Just exploring - not committed to launching yet',
};

const TAGS = {
  // Step 1 alone (name, email, phone) is a real registration — the reminder
  // sequence triggers on 'turnkey webinar registrant', so it has to be here or
  // someone who gives their contact details and stops gets no reminders and no
  // join link.
  //
  // 'turnkey webinar form started' was dropped 2026-08-20: no workflow used it
  // and the segment is derivable — registrant WITHOUT qualified and WITHOUT not
  // qualified is exactly the set who never finished the questions.
  partial: ['turnkey webinar registrant'],
  qualified: ['turnkey webinar registrant', 'turnkey webinar qualified'],
  notQualified: ['turnkey webinar registrant', 'turnkey webinar not qualified'],
};

// Post-webinar application. Deliberately a separate namespace from the
// webinar tags: a contact can be a registrant AND an applicant, and the
// weekly registrant-tag reset (WEBINAR-AUTOMATIONS.md) must never clear
// applicant state.
const APP_TAGS = {
  partial: ['turnkey application started'],
  qualified: ['turnkey applicant', 'turnkey application qualified'],
  notQualified: ['turnkey applicant', 'turnkey application not qualified'],
};

// Home care is restricted in these states; medical staffing is not
// restricted anywhere. Mirrors HOMECARE_RESTRICTED in application-inline.html
// — keep the two lists in step. Source: sales-call-analysis-2026-08.md.
const HOMECARE_RESTRICTED_TAG = 'home care restricted state';

// Step 6 investment tier -> the calendar the applicant was routed to.
const ROUTE_LABELS = {
  senior:  'Veronika — strategy call ($10k+)',
  intro:   'Caleb — discovery call ($5-10k)',
  nurture: 'Nurture page — not investing now',
};

// Dated cohort tag from the session date the page rendered, e.g.
// "Wednesday, September 2" -> "turnkey webinar registrants - 09/02/26".
//
// Format is month/day/year, zero-padded, 2-digit year, matching the sales team's
// existing convention in this sub-account ("02/04/26 webinar registrant"). These
// tags ACCUMULATE — one per webinar a contact registers for — so the format must
// never drift or the history splits across two tags nobody is looking at.
//
// The displayed date carries no year, so the year is the NEXT FUTURE OCCURRENCE
// of that month/day. That is what makes a January session promoted in December
// tag as next year rather than the current one.
//
// Returns null if the merge token did not render, which fails safe: no tag,
// rather than a garbage cohort.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                'august', 'september', 'october', 'november', 'december'];

function cohortTag(raw, now = new Date()) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  if (!s || s.includes('{{')) return null;

  const cleaned = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const m = cleaned.match(/([a-z]+)\s+(\d{1,2})/);
  if (!m) return null;

  const month = MONTHS.indexOf(m[1]);
  const day = parseInt(m[2], 10);
  if (month < 0 || !(day >= 1 && day <= 31)) return null;

  // Next future occurrence: this year unless that date has already passed.
  let year = now.getUTCFullYear();
  const thisYear = Date.UTC(year, month, day, 23, 59, 59);
  if (thisYear < now.getTime()) year += 1;

  const pad = (n) => String(n).padStart(2, '0');
  return `turnkey webinar registrants - ${pad(month + 1)}/${pad(day)}/${String(year).slice(-2)}`;
}

// ---------------------------------------------------------------------------

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.PW_GHL_TOKEN}`,
    Version: VERSION,
    'Content-Type': 'application/json',
  };
}

async function ghlFetch(path, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GHL}${path}`, { ...opts, headers: ghlHeaders(), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error(`GHL ${opts.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve field name -> id once per warm instance; create anything missing.
let fieldMapPromise = null;
function getFieldMap() {
  if (!fieldMapPromise) {
    fieldMapPromise = buildFieldMap().catch((err) => {
      fieldMapPromise = null; // let the next request retry
      throw err;
    });
  }
  return fieldMapPromise;
}

// GHL generates fieldKey from the name ("UTM Source" -> contact.utm_source),
// so a pre-existing field can collide on key while differing in display name.
// Match by name OR expected key, and if creation still reports a collision,
// adopt the id GHL hands back in the error.
function keyFor(name) {
  return 'contact.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function buildFieldMap() {
  const loc = process.env.PW_GHL_LOCATION_ID;
  const listing = await ghlFetch(`/locations/${loc}/customFields?model=contact`);
  const byName = new Map();
  const byKey = new Map();
  for (const f of listing.customFields || []) {
    if (f.name) byName.set(String(f.name).trim().toLowerCase(), f.id);
    if (f.fieldKey) byKey.set(f.fieldKey, f.id);
  }

  const map = {};
  const missing = [];
  for (const [logical, spec] of Object.entries(FIELDS)) {
    // KEY first — the existing names are unreliable (one has a trailing space,
    // one is a full sentence), the keys are stable.
    let id = byKey.get(spec.key) || byName.get(spec.name.trim().toLowerCase());

    if (!id && spec.create) {
      try {
        const created = await ghlFetch(`/locations/${loc}/customFields`, {
          method: 'POST',
          body: JSON.stringify({ name: spec.name, dataType: 'TEXT', model: 'contact' }),
        });
        id = created.customField && created.customField.id;
      } catch (err) {
        id = err.body && err.body.meta && err.body.meta.existingId;
        if (!id) throw err;
      }
    }

    if (id) map[logical] = id;
    else if (!spec.create) missing.push(`${logical} (${spec.key})`);
  }

  // A pre-existing field we could not resolve means someone renamed or deleted
  // it in GHL. Creating a replacement would look like it worked while quietly
  // splitting the data across two fields, so shout instead.
  if (missing.length) {
    await telegram('PW form relay: these EXISTING custom fields no longer resolve, ' +
      'so their answers are NOT being saved:\n' + missing.join('\n'));
  }
  return map;
}

// ---------------------------------------------------------------------------

// Alert via Telegram when configured, else fall back to the Resend email
// alert channel the showcase tracker already uses on this project.
async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  try {
    if (token && chat) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
      return;
    }
    if (process.env.RESEND_API_KEY && process.env.ALERT_EMAIL) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.ALERT_FROM_EMAIL || 'onboarding@resend.dev',
          to: process.env.ALERT_EMAIL,
          subject: text.split('\n')[0].slice(0, 80),
          text,
        }),
      });
    }
  } catch (e) { /* alerts must never break the relay */ }
}

function corsOrigin(req) {
  const allowed = (process.env.PW_ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || '';
  return allowed.includes(origin) ? origin : allowed[0];
}

function cleanStr(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false }); }
  }
  body = body || {};

  // honeypot filled = bot; say ok, sync nothing
  if (cleanStr(body.hp)) return res.status(200).json({ ok: true });

  const contact = body.contact || {};
  const answers = body.answers || {};
  const params = body.params || {};
  const flags = body.flags || {};
  const isApp = body.form === 'application';
  // registration sends partial|final; the application sends app_started|app_final
  const stage = isApp
    ? (body.stage === 'app_final' ? 'final' : 'partial')
    : (body.stage === 'final' ? 'final' : 'partial');
  const qualified = body.qualified === true;

  const firstName = cleanStr(contact.firstName, 100);
  const lastName = cleanStr(contact.lastName, 100);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const email = cleanStr(contact.email, 200).toLowerCase();
  const phone = cleanStr(contact.phone, 40);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid email' });
  }

  if (!process.env.PW_GHL_TOKEN || !process.env.PW_GHL_LOCATION_ID) {
    await telegram('🚨 PW form relay: PW_GHL_TOKEN / PW_GHL_LOCATION_ID not set — a submission was NOT synced.\n' +
      `${fullName} <${email}> ${phone}`);
    return res.status(500).json({ ok: false, error: 'relay not configured' });
  }

  try {
    const fields = await getFieldMap();
    const cf = [];
    const put = (logical, value) => {
      const v = cleanStr(String(value == null ? '' : value));
      if (v && fields[logical]) cf.push({ id: fields[logical], field_value: v });
    };
    // Radio fields reject anything that is not one of their configured options,
    // so an unmapped answer is dropped rather than written as free text.
    const putChoice = (logical, map, value) => {
      const mapped = map[String(value == null ? '' : value).trim()];
      if (mapped) put(logical, mapped);
    };

    put('utmSource', params.utm_source);
    put('utmMedium', params.utm_medium);
    put('utmCampaign', params.utm_campaign);
    put('utmTerm', params.utm_term);
    put('utmContent', params.utm_content);
    put('fbClickId', params.fbclid);
    put('fbBrowserId', params.fbp);
    put('gclid', params.gclid || params.wbraid || params.gbraid);
    put('adId', params.ad_id);
    put('adsetId', params.adset_id);
    put('campaignId', params.campaign_id);
    put('placement', params.placement);
    put('landingPage', params.landing_page);
    put('referrer', params.referrer);

    let tags;
    if (isApp) {
      // The application always carries the answers given so far, so a
      // half-finished application still tells the setter something.
      putChoice('agencyType', AGENCY_TYPE, answers.agencyType);
      put('state', answers.state);
      tags = APP_TAGS.partial;
      if (stage === 'final') {
        putChoice('stage', STAGE_APP, answers.stage);
        putChoice('capital', CAPITAL, answers.capital);
        put('timeline', answers.timeline);
        put('decision', answers.decision);
        put('notes', cleanStr(answers.notes, 900));
        // Priority follows the investment answer and nothing else.
        put('priority', PRIORITY[String(answers.capital || '').trim()]);
        // Which calendar the applicant was sent to, decided by the step 6
        // investment answer. 'senior' = Veronika, 'intro' = Caleb,
        // 'nurture' = the callbooking2 page (no sales call booked).
        put('route', ROUTE_LABELS[body.route] || '');
        tags = qualified ? APP_TAGS.qualified : APP_TAGS.notQualified;
      }
      if (flags.homecareRestrictedState === true) tags = tags.concat(HOMECARE_RESTRICTED_TAG);
    } else {
      // Registration counts as registered the moment we have a contact. The
      // remaining questions enrich the record; they are not a gate, so the
      // reminder sequence fires off the partial tag too.
      tags = TAGS.partial;
      if (stage === 'final') {
        putChoice('stage', STAGE_REG, answers.process);
        put('timeline', answers.timing);
        putChoice('investment', INVESTMENT, answers.investment);
        tags = qualified ? TAGS.qualified : TAGS.notQualified;
      }
      const cohort = cohortTag(body.session);
      if (cohort) {
        tags = tags.concat(cohort);
        put('session', body.session);
      }
    }

    // NOTE: `tags` is deliberately NOT sent here. GHL's upsert REPLACES the tag
    // array rather than merging it, so sending tags on every write wipes whatever
    // the contact already carried — an applicant lost their registrant tag and
    // their session cohort tag, and a repeat registrant lost the dated tag from
    // their previous webinar. Custom fields merge; tags do not. Proven on
    // production four times, 2026-08-19.
    //
    // Tags are added below through the dedicated endpoint, which APPENDS. That is
    // what lets the dated cohort tags accumulate, one per webinar, permanently.
    const upserted = await ghlFetch('/contacts/upsert', {
      method: 'POST',
      body: JSON.stringify({
        locationId: process.env.PW_GHL_LOCATION_ID,
        firstName,
        // Omitted rather than sent empty: an empty string would overwrite a
        // surname already on the contact from an earlier submission.
        lastName: lastName || undefined,
        email,
        phone: phone || undefined,
        source: isApp ? 'Turnkey Post-Webinar Application' : 'Turnkey Webinar Registration',
        customFields: cf,
      }),
    });

    const contactId =
      (upserted && upserted.contact && upserted.contact.id) ||
      (upserted && upserted.id) || null;

    if (contactId && tags.length) {
      // A tag failure must never cost us the lead — the contact already exists at
      // this point. Alert and carry on rather than throwing.
      try {
        await ghlFetch(`/contacts/${contactId}/tags`, {
          method: 'POST',
          body: JSON.stringify({ tags }),
        });
      } catch (tagErr) {
        await telegram('PW form relay: contact saved but TAGS FAILED, so no workflow ' +
          `will fire for them.\n${fullName} <${email}>\n${tags.join(', ')}\n` +
          String(tagErr.message).slice(0, 200));
      }
    } else if (!contactId) {
      await telegram('PW form relay: upsert returned no contact id, so NO TAGS were ' +
        `applied and no workflow will fire.\n${fullName} <${email}>`);
    }

    if (stage === 'final' && qualified && process.env.PW_LEAD_ALERTS !== 'off') {
      await telegram(
        isApp
          ? `🔥 PW Turnkey APPLICATION — qualified, booking now\n${fullName} <${email}> ${phone}\n` +
            `${ROUTE_LABELS[body.route] || 'route unknown'}\n` +
            `${cleanStr(answers.agencyType)} · ${cleanStr(answers.state)}` +
            `${flags.homecareRestrictedState === true ? ' ⚠️ restricted home care state' : ''}\n` +
            `Stage: ${cleanStr(answers.stage)}\nTimeline: ${cleanStr(answers.timeline)}\n` +
            `Capital: ${cleanStr(answers.capital)}\nDecision: ${cleanStr(answers.decision)}\n` +
            `Source: ${cleanStr(params.utm_source) || 'direct'} / ${cleanStr(params.utm_campaign) || '-'}` +
            (cleanStr(answers.notes) ? `\nNotes: ${cleanStr(answers.notes, 300)}` : '')
          : `✅ PW Turnkey QUALIFIED lead\n${fullName} <${email}> ${phone}\n` +
            `Stage: ${cleanStr(answers.process)}\nTiming: ${cleanStr(answers.timing)}\n` +
            `Source: ${cleanStr(params.utm_source) || 'direct'} / ${cleanStr(params.utm_campaign) || '-'}`
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pw-lead sync failed:', String(err.message).slice(0, 500));
    await telegram(`🚨 PW form relay: GHL sync FAILED (${stage}).\n${fullName} <${email}> ${phone}\n${String(err.message).slice(0, 300)}`);
    return res.status(502).json({ ok: false });
  }
};
