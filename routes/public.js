// routes/public.js — unauthenticated endpoints for self-serve customer flows
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { getPreset } = require("../lib/industryPresets");
const { sendMail, orgAdminEmails, notifyOrg } = require("../lib/mailer");

const PLATFORM_LABELS = {
  sales_platform: "WGW Sales Platform",
  sales_trainer:  "Sales Trainer",
  phone_agent:    "Phone Agent desk (Sophia)",
  other:          "Other",
};

// POST /api/public/request-access — self-serve access request from the sign-in page.
// No auth. Records the request, emails the requester a confirmation, and notifies
// the director/admins so they can approve and onboard end-to-end.
router.post("/request-access", async (req, res) => {
  const name    = String(req.body.name || "").trim();
  const email   = String(req.body.email || "").trim().toLowerCase();
  const phone   = String(req.body.phone || "").trim() || null;
  const platform = PLATFORM_LABELS[req.body.platform] ? req.body.platform : "sales_platform";
  const note    = String(req.body.note || "").trim() || null;

  if (!name || !email) return res.status(400).json({ error: "name and email are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });

  try {
    // Target org: explicit env, else the first organization (single-company deployments).
    let orgId = process.env.DEFAULT_ORG_ID || null;
    if (!orgId) {
      const { data: org } = await supabase.from("organizations").select("id,name").limit(1).maybeSingle();
      orgId = org?.id || null;
    }

    // One open request per email — treat repeats as a friendly ping.
    const { data: existing } = await supabase
      .from("access_requests")
      .select("id,status")
      .eq("email", email)
      .eq("status", "pending")
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase
        .from("access_requests")
        .insert({ org_id: orgId, name, email, phone, platform, note });
      if (error) throw new Error(error.message);
    }

    const label = PLATFORM_LABELS[platform];

    // 1. Confirmation to the requester.
    await sendMail({
      orgId,
      to: email,
      subject: "We received your White Glove Wireless access request",
      text: `Hi ${name.split(" ")[0]},<br/><br/>
        We received your request for access to <strong>${label}</strong>.<br/>
        The director and our team have been notified and will review it shortly.<br/><br/>
        Next steps:<br/>
        1. A team lead approves your request.<br/>
        2. You get a welcome email with a link to create your password.<br/>
        3. You sign in and complete a short onboarding (personal info, tax forms, ID).<br/><br/>
        Questions? Just reply to reach the team.` ,
    });

    if (orgId) {
      // 2. Notify director + admins in-app and by email.
      const adminEmails = await orgAdminEmails(orgId);
      await notifyOrg(orgId, {
        title: `Access request: ${name}`,
        body: `${email} requested ${label} access.${phone ? ` Phone: ${phone}.` : ""} Approve under Reps → Onboarding.`,
        type: "action",
        link: "/Reps",
      });
      for (const adminEmail of adminEmails) {
        await sendMail({
          orgId,
          to: adminEmail,
          subject: `🔔 New access request — ${name} (${label})`,
          text: `<strong>${name}</strong> (${email}${phone ? `, ${phone}` : ""}) requested <strong>${label}</strong> access.${note ? `<br/>Note: ${note}` : ""}<br/><br/>Approve or deny it under <strong>Reps → Onboarding</strong>. Approving automatically creates their account and sends the welcome email.`,
        });
      }
    }

    res.json({ success: true, message: "Request received" });
  } catch (e) {
    console.error("[public] request-access error:", e.message);
    res.status(500).json({ error: "Could not submit your request right now." });
  }
});

// POST /api/public/signup — atomic signup: creates Supabase auth user + org + super_admin role
// No JWT required. Uses service-role admin API to auto-confirm email.
router.post("/signup", async (req, res) => {
  const { org_name, password, industry_key = "general_crm" } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!org_name?.trim() || !email || !password?.trim()) {
    return res.status(400).json({ error: "org_name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    // 1. Create Supabase auth user with auto-confirmed email
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authErr) {
      // Friendly error for duplicate email
      if (authErr.message?.toLowerCase().includes("already")) {
        return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
      }
      return res.status(400).json({ error: "Unable to create account with those details." });
    }

    const userId = authData.user?.id;
    if (!userId) return res.status(500).json({ error: "User creation failed" });

    // 2. Create org with 14-day trial
    const preset = getPreset(industry_key);
    const slug = org_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      + "-" + Math.random().toString(36).slice(2, 6);

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .insert({
        name:               org_name.trim(),
        slug,
        owner_email:        email,
        plan:               "trial",
        plan_status:        "trial",
        trial_ends_at:      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        industry_key:       preset.key,
        enabled_modules:    preset.modules,
        custom_wording:     preset.wording,
        pipeline_stages:    preset.pipelineStages,
        research_tools:     preset.researchTools,
        onboarding_complete: false,
      })
      .select()
      .single();

    if (orgErr) throw new Error(orgErr.message);

    // 3. Assign user as super_admin of the new org
    const { error: roleErr } = await supabase
      .from("user_roles")
      .insert({ user_id: userId, email, role: "super_admin", org_id: org.id });

    if (roleErr) throw new Error(roleErr.message);

    console.log(`[signup] New org: ${org.name} (${org.id}) — user: ${email}`);

    res.json({ success: true, org_id: org.id, org_name: org.name });
  } catch (e) {
    console.error("[signup] Error:", e.message);
    res.status(500).json({ error: "Signup could not be completed." });
  }
});

module.exports = router;
