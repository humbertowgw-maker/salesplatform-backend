// Run agents_migration.sql using the service key (no PAT needed)
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, "../.env") });

const PROJECT_REF   = "qzudlurqmhstdrzorlxu";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;

if (!SERVICE_KEY) { console.error("SUPABASE_SERVICE_KEY not set in .env"); process.exit(1); }

const sql = readFileSync(join(__dir, "../db/agents_migration.sql"), "utf8");

// Try 1: Supabase Management API (works with PAT; may also accept service key on some projects)
async function tryManagementAPI() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok) return { ok: true, body };
  return { ok: false, status: res.status, body };
}

// Try 2: Supabase REST API — execute via pg_catalog (works on some setups)
async function tryRestExec() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey:        SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok) return { ok: true, body };
  return { ok: false, status: res.status, body };
}

console.log("Attempting migration against project", PROJECT_REF, "...\n");

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

console.log("\n❌ Both approaches failed.");
console.log("Run the migration manually in the Supabase SQL editor:");
console.log("  https://supabase.com/dashboard/project/qzudlurqmhstdrzorlxu/sql");
console.log("  Paste contents of: db/agents_migration.sql");
process.exit(1);
