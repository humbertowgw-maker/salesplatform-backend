// routes/onboarding.js — unified rep onboarding pipeline.
// One pipeline for BOTH paths: an approved self-serve access request, or the
// owner manually adding a rep. Provisioning creates the auth account (welcome
// email with set-password link), the rep record, the role row, and the
// compliance checklist (personal info, IRS W-4/W-9, driver's license, I-9,
// direct deposit) with a full timeline shown on the Reps page.
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendMail, orgAdminEmails, notifyOrg } = require("../lib/mailer");

const PLATFORM_ROLES = {
  sales_platform: "rep",
  sales_trainer:  "rep",
  phone_agent:    "agent",
  other:          "rep",
};

// ── helpers ──────────────────────────────────────────────────────────────────
async function addEvent(orgId, repId, kind, label, detail = null, actor = null) {
  await supabase.from("rep_timeline_events").insert({ org_id: orgId, rep_id: repId, kind, label, detail, actor });
}

function onboardingProgress(ob) {
  if (!ob) return 0;
  const steps = [
    ["profile_submitted_at", true],
    ["irs_signed_at", ob.irs_form_url],
    ["dl_uploaded_at", true],
    ["i9_completed_at", true],
    ["deposit_completed_at", true],
  ];
  const done = steps.filter(([k, extra]) => ob[k] && (extra === true || !!extra)).length;
  return Math.round((done / steps.length) * 100);
}

async function ensureOnboardingRow(orgId, repId) {
  const { data: existing } = await supabase
    .from("rep_onboarding").select("*").eq("rep_id", repId).maybeSingle();
  if (existing) return existing;
  const { data: created } = await supabase
    .from("rep_onboarding").insert({ org_id: orgId, rep_id: repId }).select().single();
  return created;
}

/**
 * provisionRep — THE pipeline. Used by access-request approval and manual adds.
 * Returns { rep, userId, actionLink, emailChannel, alreadyExisted }.
 */
async function provisionRep({ orgId, name, email, phone, role = "rep", color = "#f97316", actor = "system" }) {
  // 1. Auth account. generateLink does NOT send Supabase's own email, so we
  // control the welcome email ourselves.
  let userId = null;
  let actionLink = null;
  let alreadyExisted = false;
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { org_id: orgId, role }, redirect_to: process.env.FRONTEND_URL || undefined },
    });
    if (!linkErr && linkData?.user) {
      userId = linkData.user.id;
      actionLink = linkData.properties?.action_link || null;
    } else if (/already|registered|exist/i.test(linkErr?.message || "")) {
      alreadyExisted = true;
      const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      userId = (list?.users || []).find(u => u.email?.toLowerCase() === email.toLowerCase())?.id || null;
    } else if (linkErr) {
      console.warn("[onboarding] generateLink failed:", linkErr.message);
    }
  } catch (e) {
    console.warn("[onboarding] account creation error:", e.message);
  }

  // 2. Role row so they land in User Management and pass org middleware.
  if (email) {
    const { error: roleErr } = await supabase
      .from("user_roles").insert({ user_id: userId, email, role, org_id: orgId });
    if (roleErr && !/duplicate|unique/i.test(roleErr.message || "")) {
      console.warn("[onboarding] user_roles insert failed:", roleErr.message);
    }
  }

  // 3. Rep record (reuse existing row for this email instead of duplicating).
  let rep;
  const { data: existingRep } = await supabase
    .from("reps").select("*").eq("email", email).maybeSingle();
  if (existingRep) {
    rep = existingRep;
  } else {
    const { data: newRep, error: repErr } = await supabase
      .from("reps").insert({ name, email, phone: phone || null, color }).select().single();
    if (repErr) throw new Error(repErr.message);
    rep = newRep;
  }

  // 4. Onboarding checklist + timeline.
  const ob = await ensureOnboardingRow(orgId, rep.id);
  await addEvent(orgId, rep.id, "account_created",
    alreadyExisted ? "Account already existed — reused it" : "Platform account created",
    { email, role }, actor);

  // 5. Welcome email with set-password link.
  const frontend = process.env.FRONTEND_URL || "";
  const channel = await sendMail({
    orgId,
    to: email,
    subject: `Welcome to White Glove Wireless, ${name.split(" ")[0]}! 🎉`,
    text: `Hi ${name.split(" ")[0]},<br/><br/>
      <strong>Welcome to the White Glove Wireless team!</strong> Your ${role === "agent" ? "phone agent" : "sales rep"} account is ready.<br/><br/>
      <strong>Step 1 — create your password:</strong><br/>
      ${actionLink
        ? `<a href="${actionLink}" style="display:inline-block;background:#f97316;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:10px 0">Create My Password</a><br/><span style="font-size:12px;color:#64748b">(link expires in 24 hours)</span>`
        : `Sign in at <a href="${frontend}">${frontend}</a> and use <strong>Forgot password</strong> to set one.`}<br/><br/>
      <strong>Step 2 — complete your onboarding:</strong><br/>
      After signing in you'll be guided through a short checklist: personal info,
      your IRS tax form (${role === "agent" ? "W-4" : "W-4 or W-9"}), a copy of your driver's license,
      work-authorization (I-9), and direct deposit details.<br/><br/>
      Welcome aboard!<br/>— The White Glove Wireless Team`,
  });
  await addEvent(orgId, rep.id, "welcome_sent", `Welcome email sent (${channel})`, { to: email }, actor);

  await notifyOrg(orgId, {
    title: `Rep onboarded: ${name}`,
    body: alreadyExisted
      ? `${email} was re-onboarded with their existing account.`
      : `Account + welcome email sent to ${email}. They'll complete onboarding at their own pace.`,
    type: "success",
    link: "/Reps",
    userEmail: actor !== "system" ? actor : null,
  });

  return { rep, userId, actionLink, emailChannel: channel, alreadyExisted };
}

async function markCompletedIfDone(orgId, repId) {
  const { data: ob } = await supabase.from("rep_onboarding").select("*").eq("rep_id", repId).single();
  if (!ob) return;
  const done = ob.profile_submitted_at && ob.irs_form_url && ob.dl_url && ob.i9_completed_at && ob.deposit_completed_at;
  if (done && !ob.completed_at) {
    await supabase.from("rep_onboarding")
      .update({ completed_at: new Date().toISOString(), stage: "complete", updated_at: new Date().toISOString() })
      .eq("rep_id", repId);
    await addEvent(orgId, repId, "onboarding_completed", "Onboarding complete ✅");
  }
}

// ── Admin: access request queue ──────────────────────────────────────────────
router.get("/access-requests", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("access_requests")
      .select("*")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ requests: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access-requests/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: request } = await supabase
      .from("access_requests")
      .select("*")
      .eq("id", req.params.id).eq("org_id", req.orgId)
      .maybeSingle();
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "pending") return res.status(409).json({ error: `Request already ${request.status}` });

    const role = req.body.role || request.requested_role || PLATFORM_ROLES[request.platform] || "rep";
    const result = await provisionRep({
      orgId: req.orgId,
      name: request.name,
      email: request.email,
      phone: request.phone,
      role,
      actor: req.userEmail,
    });

    await supabase.from("access_requests")
      .update({ status: "approved", decided_by: req.userEmail, decided_at: new Date().toISOString(), requested_role: role, converted_rep_id: result.rep.id })
      .eq("id", request.id);
    await addEvent(req.orgId, result.rep.id, "approved",
      `Access request approved by ${req.userEmail}`, { platform: request.platform }, req.userEmail);
    await notifyOrg(req.orgId, {
      title: `Access approved: ${request.name}`,
      body: `${request.email} can now sign in after creating a password from their welcome email.`,
      type: "success",
    });

    res.json({ success: true, rep: result.rep, welcome_email: result.emailChannel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access-requests/:id/deny", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: request } = await supabase
      .from("access_requests")
      .update({ status: "denied", decided_by: req.userEmail, decided_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("org_id", req.orgId)
      .select().single();
    if (!request) return res.status(404).json({ error: "Request not found" });
    await notifyOrg(req.orgId, {
      title: `Access denied: ${request.name}`,
      body: `${request.email}'s request was denied by ${req.userEmail}.`,
      type: "warning",
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: manual add with automatic provisioning ("if I added them…") ──────
router.post("/provision-rep", requireAuth, requireAdmin, async (req, res) => {
  const { name, email, phone, role = "rep", color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (!email) return res.status(400).json({ error: "email is required to create the account" });
  try {
    const result = await provisionRep({
      orgId: req.orgId, name: name.trim(), email: String(email).trim().toLowerCase(),
      phone, role, color, actor: req.userEmail,
    });
    await addEvent(req.orgId, result.rep.id, "manual_note", `Added directly by ${req.userEmail}`, null, req.userEmail);
    res.status(201).json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rep-facing: my onboarding ────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { data: rep } = await supabase
      .from("reps").select("id,name,email").eq("email", req.verifiedEmail).maybeSingle();
    if (!rep) return res.json({ onboarded: false });
    const { data: ob } = await supabase
      .from("rep_onboarding").select("*").eq("rep_id", rep.id).maybeSingle();
    const { data: events } = await supabase
      .from("rep_timeline_events").select("*").eq("rep_id", rep.id).order("created_at");
    res.json({ onboarded: true, rep, onboarding: ob, progress: onboardingProgress(ob), events: events || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const STEP_COLUMNS = {
  profile:   ob => ({ address_line1: ob.address_line1 || null, city: ob.city || null, state: ob.state || null, zip: ob.zip || null, dob: ob.dob || null, emergency_name: ob.emergency_name || null, emergency_phone: ob.emergency_phone || null, profile_submitted_at: new Date().toISOString() }),
  irs:       ob => ({ irs_form_type: ob.form_type || "W-4", irs_signed_at: new Date().toISOString() }),
  license:   ob => ({ dl_state: ob.dl_state || null, dl_expiry: ob.dl_expiry || null }),
  i9:        ob => ({ i9_citizenship_status: ob.citizenship_status || null, i9_doc_type: ob.doc_type || null, i9_completed_at: new Date().toISOString() }),
  deposit:   ob => ({ bank_name: ob.bank_name || null, account_last4: ob.account_last4 || null, routing_number: ob.routing_number || null, deposit_completed_at: new Date().toISOString() }),
};
const STEP_EVENTS = {
  profile: ["profile_submitted", "Personal information submitted"],
  irs:     ["irs_received",       "IRS tax form signed"],
  license: ["license_uploaded",   "Driver's license details added"],
  i9:      ["i9_completed",       "Work authorization (I-9) confirmed"],
  deposit: ["deposit_added",      "Direct deposit details added"],
};

router.patch("/me/:step", requireAuth, async (req, res) => {
  const step = req.params.step;
  if (!STEP_COLUMNS[step]) return res.status(400).json({ error: "Unknown onboarding step" });
  try {
    const { data: rep } = await supabase
      .from("reps").select("id").eq("email", req.verifiedEmail).maybeSingle();
    if (!rep) return res.status(404).json({ error: "No rep record found for your account" });
    await ensureOnboardingRow(req.orgId, rep.id);
    const updates = STEP_COLUMNS[step](req.body || {});
    const { data: ob, error } = await supabase
      .from("rep_onboarding")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("rep_id", rep.id).select().single();
    if (error) throw error;
    const [kind, label] = STEP_EVENTS[step];
    await addEvent(req.orgId, rep.id, kind, label, null, req.verifiedEmail);
    await markCompletedIfDone(req.orgId, rep.id);
    res.json({ success: true, onboarding: ob, progress: onboardingProgress(ob) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rep-facing: document uploads (IRS form, driver's license, I-9 doc) ───────
const DOC_KINDS = {
  irs_form:         { column: "irs_form_url",       event: ["irs_received",      "IRS form uploaded"] },
  drivers_license:  { column: "dl_url",             event: ["license_uploaded",  "Driver's license uploaded"] },
  i9_doc:           { column: "irs_form_url",       event: ["i9_completed",      "I-9 document uploaded"], altColumn: "dl_url" },
};

router.post("/me/documents/:kind", requireAuth, async (req, res) => {
  const kind = req.params.kind;
  const spec = DOC_KINDS[kind];
  if (!spec || spec.altColumn) return res.status(400).json({ error: "Use irs_form or drivers_license" });
  const { filename, data: base64Data, contentType, meta = {} } = req.body || {};
  if (!base64Data || !filename) return res.status(400).json({ error: "filename and data are required" });
  if (Buffer.byteLength(base64Data, "base64") > 8 * 1024 * 1024) return res.status(413).json({ error: "File too large (max 8MB)" });

  try {
    const { data: rep } = await supabase
      .from("reps").select("id").eq("email", req.verifiedEmail).maybeSingle();
    if (!rep) return res.status(404).json({ error: "No rep record found for your account" });

    const path = `${req.orgId}/${rep.id}/${kind}-${Date.now()}-${filename.replace(/[^\w.\-]/g, "_")}`;
    const { error: upErr } = await supabase.storage
      .from("rep-docs")
      .upload(path, Buffer.from(base64Data, "base64"), { contentType: contentType || "application/octet-stream", upsert: false });
    if (upErr) throw upErr;

    await ensureOnboardingRow(req.orgId, rep.id);
    const stamp = new Date().toISOString();
    const updates = { [spec.column]: path, updated_at: stamp };
    if (kind === "drivers_license") {
      updates.dl_uploaded_at = stamp;
      if (meta.dl_state) updates.dl_state = meta.dl_state;
      if (meta.dl_expiry) updates.dl_expiry = meta.dl_expiry;
    }
    if (kind === "irs_form") {
      updates.irs_signed_at = stamp;
      if (meta.form_type) updates.irs_form_type = meta.form_type;
    }
    const { data: ob, error } = await supabase
      .from("rep_onboarding").update(updates).eq("rep_id", rep.id).select().single();
    if (error) throw error;

    await addEvent(req.orgId, rep.id, spec.event[0], spec.event[1], { file: filename }, req.verifiedEmail);
    await markCompletedIfDone(req.orgId, rep.id);
    res.json({ success: true, onboarding: ob, progress: onboardingProgress(ob) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: per-rep onboarding status + timeline (Reps page) ──────────────────
router.get("/reps/:repId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: ob } = await supabase
      .from("rep_onboarding").select("*")
      .eq("rep_id", req.params.repId).eq("org_id", req.orgId).maybeSingle();
    const { data: events } = await supabase
      .from("rep_timeline_events").select("*")
      .eq("rep_id", req.params.repId).eq("org_id", req.orgId)
      .order("created_at", { ascending: true });
    res.json({ onboarding: ob, progress: onboardingProgress(ob), events: events || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: view an uploaded document via a short-lived signed URL.
router.get("/reps/:repId/documents/:kind/url", requireAuth, requireAdmin, async (req, res) => {
  try {
    const column = req.params.kind === "irs_form" ? "irs_form_url"
      : req.params.kind === "drivers_license" ? "dl_url" : null;
    if (!column) return res.status(400).json({ error: "Unknown document kind" });
    const { data: ob } = await supabase
      .from("rep_onboarding").select(column).eq("rep_id", req.params.repId).eq("org_id", req.orgId).maybeSingle();
    const path = ob?.[column];
    if (!path) return res.status(404).json({ error: "No document uploaded yet" });
    const { data, error } = await supabase.storage.from("rep-docs").createSignedUrl(path, 300);
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: mark the IRS form as filed for tax reporting.
router.post("/reps/:repId/file-irs", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { tax_year, form_type } = req.body || {};
    if (!tax_year) return res.status(400).json({ error: "tax_year is required" });
    const { data: ob, error } = await supabase
      .from("rep_onboarding")
      .update({ irs_filed_at: new Date().toISOString(), irs_filed_year: String(tax_year), ...(form_type ? { irs_form_type: form_type } : {}), updated_at: new Date().toISOString() })
      .eq("rep_id", req.params.repId).eq("org_id", req.orgId)
      .select().single();
    if (error) throw error;
    if (!ob) return res.status(404).json({ error: "No onboarding record for this rep" });
    await addEvent(req.orgId, req.params.repId, "irs_filed",
      `IRS ${form_type || ob.irs_form_type || "form"} filed for tax year ${tax_year}`, { tax_year, form_type }, req.userEmail);
    res.json({ success: true, onboarding: ob });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
