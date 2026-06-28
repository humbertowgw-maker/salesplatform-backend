// Activate the three proposed agents: Queue Health, Lead Scout, EOD Report
// Usage: node scripts/activate_agents.mjs
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dir, "../.env") });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── 1. Show current state ────────────────────────────────────────────────────
const { data: agents, error: fetchErr } = await supabase
  .from("agent_registry")
  .select("*")
  .order("created_at", { ascending: true });

if (fetchErr) {
  console.error("Failed to read agent_registry:", fetchErr.message);
  process.exit(1);
}

console.log("\nCurrent agent_registry:\n");
console.table(agents.map(a => ({
  id:     a.id,
  name:   a.name || a.agent_name || a.slug,
  status: a.status,
})));

// ── 2. Find proposed agents ──────────────────────────────────────────────────
const proposed = agents.filter(a => a.status === "proposed");
if (!proposed.length) {
  console.log("\nNo agents in 'proposed' state — nothing to activate.");
  process.exit(0);
}

// Target agents by name (flexible match)
const TARGETS = ["queue health", "lead scout", "eod report"];
const nameField = agents[0]?.name !== undefined ? "name"
                : agents[0]?.agent_name !== undefined ? "agent_name"
                : "slug";

const toActivate = proposed.filter(a => {
  const n = (a[nameField] || "").toLowerCase();
  return TARGETS.some(t => n.includes(t));
});

if (!toActivate.length) {
  console.log("\nProposed agents found but none match the three targets.");
  console.log("Proposed:", proposed.map(a => a[nameField]));
  process.exit(1);
}

console.log(`\nActivating ${toActivate.length} agent(s):`, toActivate.map(a => a[nameField]));

// ── 3. Activate ──────────────────────────────────────────────────────────────
for (const agent of toActivate) {
  const { error } = await supabase
    .from("agent_registry")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (error) {
    console.error(`  ✗ ${agent[nameField]}:`, error.message);
  } else {
    console.log(`  ✓ ${agent[nameField]} → active`);
  }
}

// ── 4. Verify ────────────────────────────────────────────────────────────────
const { data: updated } = await supabase
  .from("agent_registry")
  .select("*")
  .order("created_at", { ascending: true });

console.log("\nUpdated agent_registry:\n");
console.table((updated || []).map(a => ({
  id:     a.id,
  name:   a[nameField],
  status: a.status,
})));
