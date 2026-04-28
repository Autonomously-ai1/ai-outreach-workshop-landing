// Vercel Serverless Function — POST /api/stripe-webhook
// Receives Stripe webhook events. On `checkout.session.completed` (i.e. a customer
// has successfully paid), attaches the "outreach workshop" tag to their Beehiiv
// subscriber — which is what triggers the confirmation email automation.
//
// Why the tag isn't added at form submission:
// - We don't want to send a "you're booked in" email to people who fill the form
//   but bail before paying. So Beehiiv has them as a subscriber (with custom fields
//   filled in by /api/register) but no tag, no automation triggered.
// - On Stripe payment success, this webhook adds the tag, the automation fires.
//
// Stripe dashboard setup:
//   1. Stripe → Developers → Webhooks → Add endpoint
//   2. URL: https://workshop.autonomously-ai.com/api/stripe-webhook
//   3. Events to send: checkout.session.completed
//   4. Copy the signing secret (starts with whsec_...)
//   5. Paste it into Vercel as STRIPE_WEBHOOK_SECRET env var
//   6. Redeploy
//
// Required env vars:
//   STRIPE_SECRET_KEY         — for Stripe SDK signature verification
//   STRIPE_WEBHOOK_SECRET     — whsec_... from Stripe dashboard webhook endpoint
//   BEEHIIV_API_KEY           — Beehiiv API key
//   BEEHIIV_PUBLICATION_ID    — pub_xxxxxxxx

import Stripe from 'stripe';

const WORKSHOP_TAG = 'outreach workshop';

// Stripe needs the raw request body to verify the signature.
// Vercel parses JSON bodies by default — disable that for this route.
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  if (!stripeKey || !webhookSecret) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    res.status(500).json({ error: 'webhook_not_configured' });
    return;
  }

  const stripe = new Stripe(stripeKey);
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    res.status(400).json({ error: 'invalid_signature' });
    return;
  }

  // Only act on successful checkouts. Acknowledge other events with 200 so Stripe doesn't retry.
  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ received: true, ignored: event.type });
    return;
  }

  const session = event.data.object;
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  const fullName = session.customer_details?.name || '';
  const firstName = fullName ? fullName.split(/\s+/)[0] : '';

  if (!email) {
    console.warn('Stripe session has no email:', session.id);
    res.status(200).json({ received: true, no_email: true });
    return;
  }

  // Attach the "outreach workshop" tag to the Beehiiv subscriber.
  // Best-effort: log + acknowledge even on failure so Stripe doesn't retry forever.
  try {
    const apiKey = process.env.BEEHIIV_API_KEY;
    const publicationId = process.env.BEEHIIV_PUBLICATION_ID;

    if (!apiKey || !publicationId) {
      throw new Error('Beehiiv env vars not configured');
    }

    let subId = await findBeehiivSubscriberByEmail(apiKey, publicationId, email);

    // Edge case: paid customer doesn't exist in Beehiiv (form submission failed earlier).
    // Create them now so they don't miss the confirmation automation.
    if (!subId) {
      console.warn('Paid customer not found in Beehiiv — creating from Stripe data:', email);
      subId = await createBeehiivSubscriber(apiKey, publicationId, {
        email,
        firstName,
        fullName,
      });
    }

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
      );
      console.log('Tagged paid subscriber:', subId, email);
    } else {
      console.error('Could not find or create Beehiiv subscriber for paid customer:', email);
    }
  } catch (err) {
    console.error('Failed to tag Beehiiv subscriber on payment:', err.message);
    // Still return 200 — Stripe shouldn't retry this since the failure is downstream of our service.
  }

  res.status(200).json({ received: true });
}

async function findBeehiivSubscriberByEmail(apiKey, publicationId, email) {
  try {
    const url = `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/subscriptions/by_email/${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.id || null;
  } catch (err) {
    console.warn('Beehiiv lookup failed:', err.message);
    return null;
  }
}

async function createBeehiivSubscriber(apiKey, publicationId, { email, firstName, fullName }) {
  try {
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/subscriptions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          reactivate_existing: true,
          send_welcome_email: false,
          utm_source: 'workshop_landing',
          utm_medium: 'stripe_payment_fallback',
          utm_campaign: 'beta_cohort_may_2026',
          referring_site: 'workshop.autonomously-ai.com',
          custom_fields: [
            { name: 'First Name', value: firstName },
            { name: 'Full Name', value: fullName },
          ],
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.id || null;
  } catch (err) {
    console.warn('Beehiiv create-subscriber fallback failed:', err.message);
    return null;
  }
}
