// Vercel serverless function.
// Deploy at api/create-checkout-session.js.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_PRICE_ID

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: "authentication required" }); return; }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: "invalid token" }); return; }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { supabase_user_id: user.id },
      success_url: `${req.headers.origin || 'https://formulafixer.org'}/?subscribed=true`,
      cancel_url: `${req.headers.origin || 'https://formulafixer.org'}/?canceled=true`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error', err);
    res.status(500).json({ error: "checkout failed" });
  }
}