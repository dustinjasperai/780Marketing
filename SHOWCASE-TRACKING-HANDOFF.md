# Handoff prompt — finish showcase view tracking (paste into Claude Code on the Vercel-logged-in device)

Copy everything in the fenced block below into a new Claude Code session on the device where Dustin IS logged into Vercel.

---

```
CONTEXT — please read fully before acting.

I'm Dustin. I'm NON-TECHNICAL. In a previous Claude Code session (on a different device) we built a "showcase view tracking" system but couldn't finish deploying it there because I'm not logged into Vercel on that device. You're on the device where I AM logged into Vercel. Your job: finish the setup and get me EMAIL notifications when someone views one of my prospect showcase pages. Guide me click-by-click through anything that needs my accounts/passwords/keys — do everything else yourself. Don't assume I know technical terms.

WHAT THE SYSTEM IS
- I run "D100" outreach: each prospect gets a one-page "showcase" hosted at {slug}.surge.sh (37 of them live, e.g. act-dental.surge.sh, dave-kovar.surge.sh).
- Every showcase now has a tiny tracking script ("beacon") that pings an endpoint when someone opens the page. I want an email the moment a real person views a page (tells me which prospect, so I know to follow up).
- The endpoint + a dashboard live in my marketing site repo, which deploys to https://780marketing.ca on Vercel.

CURRENT STATE (from the previous session)
- Repo: the folder `780-marketing-site` inside my vault (git remote: github.com/dustinjasperai/780marketing, branch `main`). It should be present on this device (the vault syncs between my devices via Syncthing). If it's missing, tell me.
- These files were created and committed LOCALLY (commit "Add showcase view tracking...") but NOT pushed to GitHub (the other device had no git credentials):
    - `780-marketing-site/api/track.js`      — the collector: logs each view, and EMAILS me on a real "engaged" view
    - `780-marketing-site/api/views.js`      — read API for the dashboard (needed only for the dashboard, not for email)
    - `780-marketing-site/showcase-views.html` — the dashboard page (optional, do later)
    - `780-marketing-site/SHOWCASE-TRACKING-SETUP.md` — the full written setup notes
  READ `api/track.js` and `SHOWCASE-TRACKING-SETUP.md` first to confirm details.
- The beacon is already injected into all 37 live showcases and points to `https://780marketing.ca/api/track`. Nothing else on the showcases needs changing.
- The endpoint is safe to deploy now: with no env vars set it just returns an invisible pixel and does nothing — the showcases never break. Email/logging turn on only once the env vars below exist.

SCOPE: EMAIL FIRST. Do NOT bother with Supabase/the dashboard yet — I only want email alerts working first. (Supabase is only needed for the dashboard, which we'll add later.)

=== YOUR TASKS ===

TASK 1 — Get the code onto the live site (you do this).
The `/api/*.js` files deploy as serverless functions automatically (no build step, no package.json). Do ONE of:
  (a) From the `780-marketing-site` folder, run `vercel --prod` (I'm logged into Vercel CLI on this device). This deploys the local files directly. OR
  (b) Push the repo: `git push origin main` (triggers Vercel auto-deploy from GitHub) — only if git is authenticated here.
Prefer (a). If the local commit isn't present, the files still exist in the working folder — deploy them.
After deploying, verify:
  curl -s "https://780marketing.ca/api/track?slug=test&name=Test&ev=engaged" -o /dev/null -w "%{http_code}\n"
Expect 200. (It won't email yet — env vars come next.)

TASK 2 — Set up email (walk me through the account bits).
We'll use Resend (simplest email service for this).
  2a. Guide me to sign up / log in at resend.com, then create an API key (Resend dashboard → "API Keys" → "Create API Key") and have me copy it (starts with `re_`). I'll paste it to you or into Vercel — you tell me exactly where.
  2b. Add these Environment Variables to the `780marketing` project in Vercel (Vercel → project `780marketing` → Settings → Environment Variables, Production scope). Tell me exactly what to click; I'll paste the secret values myself:
        RESEND_API_KEY   = (my re_... key)
        ALERT_EMAIL      = (the email address where I want alerts)
        ALERT_FROM_EMAIL = onboarding@resend.dev
      (Note on Resend: with the default from-address `onboarding@resend.dev`, Resend will only deliver to MY OWN Resend-account email until I verify a domain. So set ALERT_EMAIL to the same email I signed up to Resend with, to start. Later, to send anywhere / improve deliverability, verify the domain 780marketing.ca in Resend and set ALERT_FROM_EMAIL to something like alerts@780marketing.ca.)
  2c. Env var changes need a redeploy to take effect. Redeploy (run `vercel --prod` again, or in Vercel dashboard: Deployments → latest → "Redeploy").

TASK 3 — Test the email.
Run the same curl as Task 1 (with ev=engaged). I should get an email within a minute. If nothing arrives: check Vercel → project → the function logs for /api/track, confirm the env vars are set to Production, and confirm ALERT_EMAIL matches my Resend account email. Report what you find; don't guess silently.

TASK 4 — Finish 7 leftover Surge redeploys (only if Surge is logged in on this device).
7 showcase pages have the beacon in their files but haven't been re-published to Surge yet (Surge rate-limits after ~30 rapid publishes with a misleading "you do not have permission" error — it clears after a while). They are:
  josh-biro, kim-paxton, lesley-logan, michael-jay, niki-riga, patricia-welter, seran-glanfield  (all in the yoga-pilates-studio-coaches-d100 vertical)
For each, from the vault root:
  npx surge "<absolute-path-to>/Clients/Prospects/yoga-pilates-studio-coaches-d100/<slug>/showcase" <slug>.surge.sh
This needs the Surge account dustin@780copy.com (run `npx surge login` if prompted). If they still throttle, wait ~30–60 min and retry, or space them out. NOTE: this can also be done from my ORIGINAL device (Surge is already logged in there), so it's optional here — prioritise Tasks 1–3.

=== KEY FACTS / VALUES ===
- Live site / endpoint host: https://780marketing.ca  (Vercel project name: 780marketing)
- Beacon endpoint (already baked into showcases): https://780marketing.ca/api/track
- Email fires only on a genuine "engaged" view (visitor stayed ~5s with the tab visible) — this deliberately filters bots/link-scanners so I'm not spammed. Every raw hit is still logged (for the future dashboard). If I later say I want an email on EVERY open, the change is in `api/track.js` (the line `if (ev === "engaged" && !isBot)`), then redeploy.
- Exact env var names (from the code): RESEND_API_KEY, ALERT_EMAIL, ALERT_FROM_EMAIL. (For the later dashboard: SUPABASE_URL, SUPABASE_SERVICE_KEY, DASHBOARD_KEY.)
- Pre-generated DASHBOARD_KEY for when we do the dashboard later: acc9f46bc546607049e0af2db6ed985fd4e983012ccc0c87
- The tracker injector for FUTURE showcase builds: `Scripts/utilities/inject_showcase_tracker.py` (run it before the surge deploy; it's idempotent).
- Full written details are in `780-marketing-site/SHOWCASE-TRACKING-SETUP.md`.

Start with Task 1. Go one step at a time and wait for me on anything involving my logins or keys.
```

---

## For Dustin (not part of the paste): what to expect
- The other session will deploy the code, then walk you through a quick Resend signup + pasting 3 values into Vercel, then send a test email.
- You'll only ever type: your Resend signup, your Resend key, and your alert email. Everything else it does.
- The dashboard (seeing a list/history of views) is deliberately left for later — email alerts come first.
