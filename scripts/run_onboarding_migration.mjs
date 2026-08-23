// Run onboarding_migration.sql against Supabase (service key / management API)
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_REF   = "qzudlurqmhstdrzorlxu";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;

if (!SERVICE_KEY) { console.error("SUPABASE_SERVICE_KEY not set"); process.exit(1); }

const sql = readFileSync(join(__dir, "../db/onboarding_migration.sql"), "utf8");

async function tryManagementAPI() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function tryRestExec() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

let result = await tryManagementAPI();
if (result.ok) {
  console.log("✓ Migration completed via Management API");
  console.log(JSON.stringify(result.body, null, 2));
  process.exit(0);
}
console.log("Management API attempt:", result.status, JSON.stringify(result.body));

result = await tryRestExec();
if (result.ok) {
  console.log("✓ Migration completed via REST exec");
  console.log(JSON.stringify(result.body, null, 2));
  process.exit(0);
}
console.log("REST exec attempt:", result.status, JSON.stringify(result.body));
console.log("\n❌ Both approaches failed. Run db/onboarding_migration.sql manually at:");
console.log(`  https://supabase.com/dashboard/project/${PROJECT_REF}/sql`);
process.exit(1);
