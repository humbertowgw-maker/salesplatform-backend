// lib/agents/reviewRequest.js — Review Request Agent
// Sends a review request SMS to leads that converted in the last 24–72 hours.

const supabase = require("../../db/supabase");
const { sendSms } = require("../sms");

const REVIEW_WINDOW_HOURS = 72;
const MIN_HOURS_AFTER     = 24;  // wait at least 24h before asking for review
const BATCH_SIZE          = 15;

function buildReviewMessage({ businessName, ownerName, reviewUrl }) {
  const name = ownerName ? `${ownerName}` : "there";
  const url  = reviewUrl || process.env.REVIEW_URL || "https://g.page/r/review";
  return `Hi ${name}, thank you for choosing us for ${businessName}'s internet service! We'd love to hear about your experience. Would you mind leaving us a quick review? ${url} — it takes less than a minute and means the world to us!`;
}

async function runReviewRequest(orgId = null) {
  const windowStart = new Date(Date.now() - REVIEW_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const minAfter    = new Date(Date.now() - MIN_HOURS_AFTER   * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("leads")
    .select("id, business_name, owner_name, phone, updated_at")
    .eq("status", "Converted")
    .gte("updated_at", windowStart)
    .lte("updated_at", minAfter)
    .not("phone", "is", null)
    .limit(BATCH_SIZE);

  if (orgId) query = query.eq("org_id", orgId);

  const { data: leads, error } = await query;
  if (error) throw error;
  if (!leads?.length) {
    console.log("[review-request] No recently converted leads in window");
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;

  for (const lead of leads) {
    // Skip if already sent a review request
    const { data: prior } = await supabase
      .from("text_logs")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("source", "review-request")
      .limit(1)
      .maybeSingle();

    if (prior) { skipped++; continue; }

    const message = buildReviewMessage({
      businessName: lead.business_name,
      ownerName:    lead.owner_name,
    });

    try {
      await sendSms({
        leadId:  lead.id,
        toPhone: lead.phone,
        body:    message,
        orgId,
        source:  "review-request",
      });

      sent++;
      console.log(`[review-request] Sent to: ${lead.business_name}`);
    } catch (e) {
      console.error(`[review-request] Failed for ${lead.business_name}:`, e.message);
      skipped++;
    }
  }

  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "review-request");

  console.log(`[review-request] done — sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}

module.exports = { runReviewRequest };
