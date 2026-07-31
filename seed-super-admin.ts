// ============================================================================
// One-time seed script: creates the first super_admin.
// ----------------------------------------------------------------------------
// Run this ONCE, locally, from a trusted machine (never in the browser —
// it uses the service role key). It's the only way to get a super_admin
// into the system, since admin-create-user refuses to let anyone create a
// super_admin unless the caller already is one (chicken-and-egg on day one).
//
// Usage:
//   export SUPABASE_URL="https://yqxropanteefpyfwjglt.supabase.co"
//   export SUPABASE_SERVICE_ROLE_KEY="<service role key from Project Settings → API>"
//   deno run --allow-net --allow-env seed-super-admin.ts \
//     --email you@company.com --password "SomeStrongTempPassw0rd!" --name "Your Name"
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";

const args = parseArgs(Deno.args, {
  string: ["email", "password", "name"],
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.");
  Deno.exit(1);
}
if (!args.email || !args.password || !args.name) {
  console.error("Usage: deno run --allow-net --allow-env seed-super-admin.ts --email <email> --password <password> --name <full name>");
  Deno.exit(1);
}
if (args.password.length < 8) {
  console.error("Password must be at least 8 characters.");
  Deno.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email: args.email,
  password: args.password,
  email_confirm: true,
  app_metadata: { role: "super_admin" },
  user_metadata: { full_name: args.name },
});

if (createErr) {
  console.error("Failed to create auth user:", createErr.message);
  Deno.exit(1);
}

const { error: insertErr } = await admin.from("profiles").insert({
  id: created.user.id,
  email: args.email,
  full_name: args.name,
  role: "super_admin",
});

if (insertErr) {
  console.error("Auth user created but profile insert failed — rolling back:", insertErr.message);
  await admin.auth.admin.deleteUser(created.user.id);
  Deno.exit(1);
}

console.log(`✅ Super Admin created: ${args.email} (id: ${created.user.id})`);
