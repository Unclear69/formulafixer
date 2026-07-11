// Vercel serverless function.
// Deploy at api/stripe-webhook.js.
// Env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Vercel auto-parses JSON bodies by default, which consumes the raw request
// stream before this handler runs — Stripe's signature check needs the exact
// unparsed bytes it signed, so that auto-parsing must be turned off for this route.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await buffer(req),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed', err);
    res.status(400).json({ error: "invalid signature" });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id;
        if (!userId) break;
        const customerId = session.customer;
        await supabase.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: typeof customerId === 'string' ? customerId : '',
          status: 'active',
          current_period_end: null
        }, { onConflict: 'user_id' });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = typeof subscription.customer === 'string' ? subscription.customer : '';
        if (!customerId) break;
        const { data: rows } = await supabase.from('subscriptions').select('user_id').eq('stripe_customer_id', customerId).limit(1);
        if (!rows || !rows.length) break;
        const userId = rows[0].user_id;
        const status = subscription.status === 'active' ? 'active' : 'inactive';
        const periodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;
        await supabase.from('subscriptions').update({ status, current_period_end: periodEnd }).eq('user_id', userId);
        break;
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error', err);
    res.status(500).json({ error: "webhook processing failed" });
  }
}

// Helper to read the raw body for signature verification
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}