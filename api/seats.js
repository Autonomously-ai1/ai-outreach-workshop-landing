// Vercel Serverless Function — GET /api/seats
// Returns live seat count by querying Stripe for completed checkout sessions
// on the workshop payment link.
//
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... (or sk_test_...)
//   STRIPE_PAYMENT_LINK_ID — plink_1TPo0t03D1V6Zsk4ULBpC7ir
//   TOTAL_SEATS            — "20" (string)
//
// Optional env vars:
//   MIN_REMAINING — Floor for the displayed `remaining` count.
//                   When set (e.g. "2"), the counter never shows below this number,
//                   even if real sold count exceeds total. Stripe keeps accepting
//                   unlimited payments under the hood.
//                   Default: 0 (counter reflects reality).
//
// Response: { sold: number, total: number, remaining: number }

const CACHE_TTL_MS = 60_000; // 60 seconds

// In-memory cache, persists across requests within the same lambda instance
let cache = null;
let cacheExpiresAt = 0;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const total = parseInt(process.env.TOTAL_SEATS || '20', 10);
  const minRemaining = Math.max(0, parseInt(process.env.MIN_REMAINING || '0', 10));

  // Cache hit
  if (cache && Date.now() < cacheExpiresAt) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(cache);
    return;
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const paymentLinkId = process.env.STRIPE_PAYMENT_LINK_ID;

    if (!stripeKey || !paymentLinkId) {
      throw new Error('Missing required env vars (STRIPE_SECRET_KEY or STRIPE_PAYMENT_LINK_ID)');
    }

    const url = `https://api.stripe.com/v1/checkout/sessions?payment_link=${encodeURIComponent(paymentLinkId)}&status=complete&limit=100`;

    const stripeRes = await fetch(url, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });

    if (!stripeRes.ok) {
      const body = await stripeRes.text();
      console.error('Stripe API error:', stripeRes.status, body);
      throw new Error(`Stripe API ${stripeRes.status}`);
    }

    const data = await stripeRes.json();
    const realSold = Array.isArray(data.data) ? data.data.length : 0;

    // Apply optional scarcity floor — never show fewer than MIN_REMAINING seats.
    const remaining = Math.max(minRemaining, total - realSold);
    const sold = total - remaining;

    const result = { sold, total, remaining };

    cache = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(result);
  } catch (err) {
    console.error('seats endpoint error:', err.message);
    // Fail gracefully — return safe defaults so the page never breaks.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ sold: 0, total, remaining: total, error: 'count_unavailable' });
  }
}
