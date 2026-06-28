// Run agents_migration.sql against Supabase
// Usage: node scripts/run_agents_migration.mjs <supabase_access_token>
// Get token: https://supabase.com/dashboard/account/tokens

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_REF = "qzudlurqmhstdrzorlxu";
const sql = readFileSync(join(__dir, "../db/agents_migration.sql"), "utf8");

const accessToken = process.argv[2];
if (!accessToken) {
  console.error("Usage: node scripts/run_agents_migration.mjs <supabase_access_token>");
  console.error("Get yours at: https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}

console.log("Running agents migration against project", PROJECT_REF, "...");
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const body = await res.json().catch(() => res.text());
if (!res.ok) {
  console.error("Migration failed:", JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log("✓ Migration completed successfully");
console.log(JSON.stringify(body, null, 2));
