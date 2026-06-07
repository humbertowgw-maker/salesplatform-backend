// lib/usageMeter.js — per-org usage metering and cap enforcement
const supabase = require("../db/supabase");

const LIMITS = {
  trial:   { call: 20,    sms: 50,    ai_message: 100   },
  starter: { call: 500,   sms: 1000,  ai_message: 2000  },
  growth:  { call: 2000,  sms: 5000,  ai_message: 10000 },
  pro:     { call: 99999, sms: 99999, ai_message: 99999 },
};

// Upstream cost estimates in USD (marked as estimates — replace with actuals when available)
// Bland.ai: ~$0.15/call (enhanced model, ~2min avg). Twilio: $0.0079/SMS (standard).
// Anthropic claude-sonnet-4: $3/M input + $15/M output tokens — per-endpoint estimates below.
const COST_ESTIMATES_USD = {
  call: 0.15,
  sms:  0.0079,
  ai_message: {
    default:    0.008,
    prioritize: 0.008,
    script:     0.007,
    fcc:        0.005,
    assistant:  0.015,   // higher: web_search tool included
  },
};

function estimateCost(eventType, metadata = {}) {
  const entry = COST_ESTIMATES_USD[eventType];
  if (entry === undefined) return null;
  if (typeof entry === "number") return entry;
  return entry[metadata.endpoint] ?? entry.default ?? null;
}

function meterError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

async function rpcOnce(orgId, eventType, limit, costUsd, metadata) {
  return supabase.rpc("meter_usage", {
    p_org_id:     orgId,
    p_event_type: eventType,
    p_limit:      limit,
    p_cost_usd:   costUsd,
    p_metadata:   metadata,
  });
}

async function checkAndRecord(orgId, eventType, metadata = {}) {
  if (!orgId) {
    throw meterError(401, "No organization context — request cannot be metered");
  }

  // Fetch org plan — retry once on transient DB failure
  let org;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300));
    const { data, error } = await supabase
      .from("organizations")
      .select("plan, plan_status")
      .eq("id", orgId)
      .single();
    if (!error) { org = data; break; }
    if (attempt === 1) {
      console.error("[meter] org fetch failed after retry:", error.message);
      throw meterError(503, "Usage verification unavailable — please try again shortly");
    }
  }

  // Non-active orgs are capped at trial limits regardless of their plan field
  const effectivePlan = org.plan_status === "active"
    ? (LIMITS[org.plan] ? org.plan : "trial")
    : "trial";
  const limit = LIMITS[effectivePlan][eventType] ?? LIMITS.trial[eventType] ?? 0;

  const costUsd = estimateCost(eventType, metadata);

  // Atomic check + increment via Postgres function — retry once on failure
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300));
    const { data, error } = await rpcOnce(orgId, eventType, limit, costUsd, metadata);
    if (!error) { result = data; break; }
    if (attempt === 1) {
      console.error("[meter] RPC failed after retry:", error.message);
      // Fail-closed: can't verify usage, refuse the action
      throw meterError(503, "Usage verification unavailable — please try again shortly");
    }
  }

  if (!result?.allowed) {
    if (result?.reason === "org_not_found") {
      throw meterError(404, "Organization not found");
    }
    throw meterError(429,
      `Monthly ${eventType} limit reached (${result?.current}/${result?.limit}). Upgrade your plan to continue.`,
      { current: result?.current, limit: result?.limit }
    );
  }
}

module.exports = { checkAndRecord, LIMITS, COST_ESTIMATES_USD };
