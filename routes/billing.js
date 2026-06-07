const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

const PLANS = {
  starter: { name: "Starter", price: 99,  maxReps: 1,   maxCalls: 500   },
  growth:  { name: "Growth",  price: 199, maxReps: 5,   maxCalls: 2000  },
  pro:     { name: "Pro",     price: 299, maxReps: 999, maxCalls: 99999 },
};

router.post("/create-checkout", async (req, res) => {
  const { plan, org_id, email } = req.body;
  if (!plan || !org_id) return res.status(400).json({ error: "plan and org_id required" });
  if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Stripe not configured" });
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const planData = PLANS[plan];
    let customerId;
    const { data: org } = await supabase.from("organizations").select("stripe_customer_id").eq("id", org_id).maybeSingle();
    if (org?.stripe_customer_id) { customerId = org.stripe_customer_id; }
    else { const customer = await stripe.customers.create({ email, metadata: { org_id } }); customerId = customer.id; if (org) await supabase.from("organizations").update({ stripe_customer_id: customerId }).eq("id", org_id); }
    const session = await stripe.checkout.sessions.create({
      customer: customerId, payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "usd", product_data: { name: `White Glove Wireless — ${planData.name}` }, unit_amount: planData.price * 100, recurring: { interval: "month" } }, quantity: 1 }],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL || "https://white-glove-frontend.vercel.app"}?billing=success`,
      cancel_url: `${process.env.LANDING_URL || "https://whitegwireless.com"}`,
      metadata: { org_id, plan },
      subscription_data: { trial_period_days: 14, metadata: { org_id, plan } },
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/webhook", async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const { metadata, subscription: subId } = event.data.object;
      const { org_id, plan } = metadata || {};
      if (org_id && plan && PLANS[plan]) {
        const { data: existing } = await supabase.from("organizations").select("converted_at").eq("id", org_id).single();
        await supabase.from("organizations").update({
          plan, plan_status: "active",
          stripe_subscription_id: subId,
          max_reps: PLANS[plan].maxReps,
          max_calls_month: PLANS[plan].maxCalls,
          converted_at: existing?.converted_at || new Date().toISOString(),
        }).eq("id", org_id);
      }
    }
    if (event.type === "customer.subscription.deleted") await supabase.from("organizations").update({ plan_status: "cancelled", plan: "trial" }).eq("stripe_subscription_id", event.data.object.id);
    if (event.type === "invoice.payment_failed") await supabase.from("organizations").update({ plan_status: "past_due" }).eq("stripe_customer_id", event.data.object.customer);
    res.json({ received: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/portal", async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const { data: org } = await supabase.from("organizations").select("stripe_customer_id").eq("id", req.body.org_id).single();
    if (!org?.stripe_customer_id) return res.status(400).json({ error: "No billing account" });
    const session = await stripe.billingPortal.sessions.create({ customer: org.stripe_customer_id, return_url: process.env.FRONTEND_URL || "https://white-glove-frontend.vercel.app" });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/status/:org_id", async (req, res) => {
  try {
    const { data: org } = await supabase.from("organizations")
      .select("plan, plan_status, trial_ends_at, max_reps, max_calls_month, calls_this_month, sms_this_month, ai_calls_this_month, billing_period_start, name")
      .eq("id", req.params.org_id).single();
    if (!org) return res.status(404).json({ error: "Org not found" });
    const trialDaysLeft = org.trial_ends_at ? Math.max(0, Math.ceil((new Date(org.trial_ends_at) - new Date()) / (1000*60*60*24))) : 0;
    res.json({ ...org, trial_days_left: trialDaysLeft });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/billing/my-usage — usage counters for the authenticated org
router.get("/my-usage", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No organization context" });
  try {
    const { data: org } = await supabase.from("organizations")
      .select("plan, plan_status, calls_this_month, sms_this_month, ai_calls_this_month, billing_period_start")
      .eq("id", req.orgId).single();
    if (!org) return res.status(404).json({ error: "Org not found" });

    const { LIMITS } = require("../lib/usageMeter");
    const effectivePlan = org.plan_status === "active" ? (LIMITS[org.plan] ? org.plan : "trial") : "trial";
    const limits = LIMITS[effectivePlan];

    res.json({
      plan: effectivePlan,
      billing_period_start: org.billing_period_start,
      usage: {
        call:       { used: org.calls_this_month || 0,       limit: limits.call       },
        sms:        { used: org.sms_this_month   || 0,       limit: limits.sms        },
        ai_message: { used: org.ai_calls_this_month || 0,    limit: limits.ai_message },
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
