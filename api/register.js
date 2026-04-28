// Vercel Serverless Function — POST /api/register
// Receives form submissions from register.html, pushes the subscriber into Beehiiv
// with the "outreach workshop" tag + custom fields populated.
// Always returns success to the client so they proceed to Stripe even if Beehiiv hiccups.
//
// Beehiiv flow is 2 calls:
//   1. POST /subscriptions     — creates subscriber + custom fields
//   2. POST /subscriptions/{id}/tags — attaches the "outreach workshop" tag
//
// Custom fields must exist on the publication first (created via dashboard or API).
// We use display names: "First Name", "Full Name", "Workshop Challenge".
//
// Required env vars:
//   BEEHIIV_API_KEY         — Beehiiv personal API key
//   BEEHIIV_PUBLICATION_ID  — pub_xxxxxxxx (Beehiiv → Settings → Publications)
//   BEEHIIV_AUTOMATION_ID   — (optional) automation ID to enrol new subscribers
//
// Request body:  { name, email, challenge?, workshop?, source?, timestamp? }
// Response:      { success: true } (always — never blocks the user from paying)

const WORKSHOP_TAG = 'outreach workshop';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let payload = req.body;
  // Vercel auto-parses JSON for application/json — but be defensive
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
  }
  if (!payload) {
    res.status(400).json({ error: 'no_body' });
    return;
  }

  const name = (payload.name || '').toString().trim();
  const email = (payload.email || '').toString().trim().toLowerCase();
  const challenge = payload.challenge ? String(payload.challenge).trim() : null;

  if (!name) {
    res.status(400).json({ error: 'name_required' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }

  // Push to Beehiiv (best-effort — never blocks the user)
  try {
    const apiKey = process.env.BEEHIIV_API_KEY;
    const publicationId = process.env.BEEHIIV_PUBLICATION_ID;

    if (apiKey && publicationId) {
      // Step 1: Create the subscriber with custom fields
      const beehiivPayload = {
        email,
        reactivate_existing: true,
        send_welcome_email: false,
        utm_source: 'workshop_landing',
        utm_medium: 'register_form',
        utm_campaign: 'beta_cohort_may_2026',
        referring_site: 'workshop.autonomously-ai.com',
        custom_fields: [
          { name: 'First Name', value: name.split(/\s+/)[0] },
          { name: 'Full Name', value: name },
          { name: 'Workshop Challenge', value: challenge || '' },
        ],
      };

      const beehiivRes = await fetch(
        `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/subscriptions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(beehiivPayload),
        }
      );

      if (!beehiivRes.ok) {
        console.warn('Beehiiv subscribe failed:', beehiivRes.status, await beehiivRes.text());
      } else {
        const subData = await beehiivRes.json();
        const subId = subData?.data?.id;

        // Step 2: Attach the "outreach workshop" tag (separate endpoint required by Beehiiv)
        if (subId) {
          await fetch(
            `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/subscriptions/${encodeURIComponent(subId)}/tags`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ tags: [WORKSHOP_TAG] }),
            }
          ).catch((err) => console.warn('Beehiiv tag attach failed:', err.message));
        }

        // Step 3 (optional): enrol in Beehiiv automation if configured
        if (subId && process.env.BEEHIIV_AUTOMATION_ID) {
          await fetch(
            `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/automations/${encodeURIComponent(process.env.BEEHIIV_AUTOMATION_ID)}/journeys`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ subscription_id: subId }),
            }
          ).catch(() => {/* best-effort */});
        }
      }
    } else {
      console.warn('Beehiiv env vars missing — skipping subscriber push');
    }
  } catch (err) {
    console.error('register handler error:', err.message);
  }

  // Always succeed — payment must not be blocked by Beehiiv issues
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ success: true });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
