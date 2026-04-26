# AI Outreach Workshop — Landing Page

Static landing page + 2 serverless API endpoints for the workshop funnel.
Deployed via **Vercel** (Git-connected for auto-deploys on push).

## Stack

- **Static HTML/CSS/JS** — `index.html`, `register.html`, `thankyou.html`, `styles.css`, `assets/`
- **Vercel Serverless Functions** in `api/` — `seats.js`, `register.js`
- **Stripe** = source of truth for paid attendees (live counter pulls from this)
- **Beehiiv** = email list / subscriber DB (form data pushed here)

No custom database. Stripe + Beehiiv are the system of record.

## Architecture

```
Visitor lands on /
  → Page fetches /api/seats on load
  → JS updates banner ("Only X seats remaining") + final CTA ("X of 20 taken") live

Visitor clicks "Reserve my seat"
  → Goes to /register.html
  → Fills in name, email, optional challenge
  → Form POSTs to /api/register
      → Server-side: pushes subscriber to Beehiiv (with custom fields incl. challenge)
      → Returns success
  → Browser redirects to Stripe payment link (with email prefilled)

Visitor pays
  → Stripe redirects to /thankyou.html
  → Thank-you page reads sessionStorage, greets them by first name
  → 3 calendar buttons (Google, Outlook, Apple/.ics) for adding to calendar

Counter updates
  → /api/seats queries Stripe live, caches 60s
  → Each new payment shows up on next page load
```

## Deployment — Vercel

### One-time setup

1. **Import the GitHub repo at [vercel.com/new](https://vercel.com/new)** → connect to your GitHub → select this repo → Import.

2. **Framework preset:** "Other" (it's a static site with serverless functions, no framework)

3. **Build settings:** leave defaults — Vercel auto-detects:
   - Build command: (leave empty)
   - Output directory: (leave empty — root)
   - Install command: (leave empty)

4. **Environment variables** (Project Settings → Environment Variables):

   | Variable | Required | Value |
   |----------|----------|-------|
   | `STRIPE_SECRET_KEY` | ✅ | `sk_live_...` from Stripe → Developers → API keys |
   | `STRIPE_PAYMENT_LINK_ID` | ✅ | `plink_1TPo0t03D1V6Zsk4ULBpC7ir` |
   | `TOTAL_SEATS` | ✅ | `20` |
   | `BEEHIIV_API_KEY` | ✅ | from Beehiiv → Settings → API |
   | `BEEHIIV_PUBLICATION_ID` | ✅ | `pub_...` from Beehiiv → Settings → Publications |
   | `BEEHIIV_AUTOMATION_ID` | optional | automation ID to enrol new subscribers in the workshop email sequence |
   | `MIN_REMAINING` | optional | `2` to floor the seat counter (never shows below 2 even when sold out). `0` or unset = real count. |

   Apply to: **Production, Preview, Development** (or just Production if you want previews to be neutral).

5. **Connect your custom domain** — Project Settings → Domains → Add `workshop.autonomously-ai.com`. Vercel gives you a `CNAME` value to add in your DNS provider (Squarespace).

   In Squarespace → Settings → Domains → autonomously-ai.com → DNS → Custom Records → Add:
   - Host: `workshop`
   - Type: `CNAME`
   - Data: (whatever Vercel told you, e.g. `cname.vercel-dns.com`)

   Wait 5–30 min for DNS propagation. SSL provisioned automatically.

6. **Update Stripe payment link "After payment"**
   - Stripe dashboard → Payment Links → AI Outreach Workshop link
   - "After payment" → Don't show confirmation page → Redirect to your website
   - URL: `https://workshop.autonomously-ai.com/thankyou.html`

### Verify it works

1. Visit `https://workshop.autonomously-ai.com/` → banner should show "Only 20 seats remaining"
2. Visit `https://workshop.autonomously-ai.com/api/seats` → should return JSON `{"sold":0,"total":20,"remaining":20}`
3. Submit the register form with a real email → check Beehiiv for the subscriber + Stripe for the prefilled email
4. Pay £149 with a real card → confirm redirect to `/thankyou.html` and counter decrements on next reload

### Scarcity floor (optional)

Set `MIN_REMAINING=2` in env vars to prevent the public-facing seat counter from ever dropping below that number. Stripe keeps accepting payments above the cap — it's purely a display floor.

- `MIN_REMAINING=0` (default) — counter shows real Stripe count, hits 0 when sold out
- `MIN_REMAINING=2` — counter never shows below 2 (e.g. once 18 sold, sticks at "2 seats remaining")

⚠️ **Note:** Showing fake scarcity is a common e-commerce pattern but the UK Consumer Protection from Unfair Trading Regs technically prohibits misleading availability claims. Risk for a £149 beta is essentially zero.

## Local development

To preview locally:

```bash
# Static-only preview (counter won't work — no /api/seats locally)
python3 -m http.server 4321

# Full preview with serverless functions:
npm install -g vercel
vercel dev   # starts local server with API routes
```

For local function testing, create `.env.local`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PAYMENT_LINK_ID=plink_1TPo0t03D1V6Zsk4ULBpC7ir
TOTAL_SEATS=20
BEEHIIV_API_KEY=...
BEEHIIV_PUBLICATION_ID=pub_...
```

(`.env.local` is in `.gitignore` — never commit it.)

## File reference

| File | Purpose |
|------|---------|
| `index.html` | Landing page — hero, hours, teacher (Mohammed), FAQ, final CTA |
| `register.html` | Form page — name, email, optional challenge → POST /api/register → Stripe |
| `thankyou.html` | Post-payment confirmation, calendar buttons (Google/Outlook/Apple), Discord link |
| `styles.css` | Single stylesheet for all pages |
| `assets/` | Logo, avatars, OG image, price tag |
| `api/seats.js` | GET — returns live seat count from Stripe |
| `api/register.js` | POST — pushes subscriber to Beehiiv |
| `package.json` | Tells Vercel this is a Node project |
| `.gitignore` | Standard ignores |

## Key placeholders that still need replacing in source

| Placeholder | Where | What |
|-------------|-------|------|
| `[DISCORD_INVITE]` | `thankyou.html` | Discord workshop channel invite URL |

## Add-to-Calendar buttons

The thank-you page has 3 calendar buttons (Google / Outlook / Apple/.ics) that auto-generate calendar events for **Friday 8 May 2026, 11am–3pm BST**. The .ics file includes 24h and 1h-before reminders.

Calendar events use placeholder Zoom location ("Zoom — link sent morning of"). When you have the real Zoom URL, edit `thankyou.html` → `event.location` in the JS block → replace with the real Zoom URL → push to git → Vercel auto-deploys.

## Behaviour notes

- **`/api/seats` failure mode:** If Stripe API is down or credentials are missing, the endpoint returns `{sold: 0, total: 20, remaining: 20}` so the page never breaks.
- **`/api/register` failure mode:** If Beehiiv push fails, the endpoint still returns `{success: true}` so the user proceeds to payment. We never block a sale on a marketing-tool failure. Beehiiv failures are logged in Vercel → Project → Logs.
- **Cache:** `/api/seats` caches 60s in-memory (per lambda instance). New payments take up to 60s to show on the counter.
- **Seat low / sold-out states:** When `remaining ≤ 5`, `<body>` gets the class `seats-low`. When `remaining = 0`, it gets `seats-sold-out`. CSS hooks for these aren't styled yet — add styling later if you want urgent visual treatment.
