# Showcase View Tracking — Setup

Every live prospect showcase (37 pages on `*.surge.sh`) now sends a small beacon to
`https://780marketing.ca/api/track` when someone opens it. This repo holds the collector,
the read API, and the dashboard. **Three one-time steps and it's live.** Until then the
beacons just no-op silently (they never break the showcase).

What you get:
- **Instant alert** (Telegram and/or email) the moment a prospect *engages* with their page
  (stayed 5s+ with the tab actually visible — filters out link scanners and prefetch).
- **Dashboard** at `https://780marketing.ca/showcase-views` — grouped by prospect, timeline,
  view counts, location, last-seen.

---

## 1. Create the Supabase table

Run this in the Supabase SQL editor (same project as your other `aid_*` tables is fine):

```sql
create table if not exists public.showcase_views (
  id bigint generated always as identity primary key,
  slug text, name text, vertical text, event text,
  referrer text, page_url text, visit_id text,
  ip text, user_agent text, country text, region text, city text,
  is_bot boolean default false,
  created_at timestamptz default now()
);
create index if not exists showcase_views_slug_idx on public.showcase_views (slug);
create index if not exists showcase_views_created_idx on public.showcase_views (created_at desc);
```

RLS can stay on (default) — the API uses the service-role key, which bypasses it. Nothing else reads this table.

## 2. Set env vars on the `780marketing` Vercel project

Required (storage + dashboard):
| Var | Value |
|-----|-------|
| `SUPABASE_URL` | `https://<your-project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service-role key (Supabase → Settings → API) |
| `DASHBOARD_KEY` | any long random string you make up — this is your dashboard password |

Alerts — set **Telegram** or **email** (or both). Any you skip is simply off.

Telegram (instant phone pings, free):
| Var | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | from @BotFather (`/newbot`) |
| `TELEGRAM_CHAT_ID` | message your new bot once, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (or DM @userinfobot) |

Email (via Resend):
| Var | Value |
|-----|-------|
| `RESEND_API_KEY` | `re_...` |
| `ALERT_EMAIL` | where alerts go (e.g. dustin@780marketing.com) |
| `ALERT_FROM_EMAIL` | a verified Resend sender (optional; defaults to `onboarding@resend.dev`) |

> Use `printf` not `echo` if setting via CLI (`vercel env add`) — echo appends a newline that breaks token comparisons.

## 3. Deploy

The `/api/*.js` files deploy as serverless functions automatically (no build, no package.json).

```bash
cd 780-marketing-site
vercel --prod            # CLI deploy (reliable), or push to the dustinjasperai/780marketing repo for auto-deploy
```

Verify:
```bash
curl -s "https://780marketing.ca/api/track?slug=test&name=Test&ev=engaged" -o /dev/null -w "%{http_code}\n"   # 200
```
Then open `https://780marketing.ca/showcase-views#key=YOUR_DASHBOARD_KEY`. A test row should appear (and you should get an alert if Telegram/email is set).

---

## How it works / notes

- **Collector:** `api/track.js` — logs every hit, alerts only on `event=engaged` from non-bots.
- **Read API:** `api/views.js?key=DASHBOARD_KEY` — the dashboard's data source, secret-guarded.
- **Dashboard:** `showcase-views.html` (noindex).
- **Beacon:** injected before `</body>` of every `showcase/index.html` by
  `Scripts/utilities/inject_showcase_tracker.py` (idempotent — safe to re-run; new builds should run it before the surge deploy).
- **Bot filtering:** JS-based beacon (scanners rarely run JS) + a user-agent bot list + the 5s-visible engaged gate. Expect very little noise.
- **New showcases:** run the injector, then `surge ./showcase <slug>.surge.sh`. The snippet auto-derives slug/name/vertical.
- **Re-deploying many at once:** Surge throttles after ~30 rapid publishes and returns a misleading "no permission" error. Space them out or retry after a few minutes.
