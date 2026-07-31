// ============================================================================
// Edge Function: admin-create-user
// ----------------------------------------------------------------------------
// Called by js/data.js's adminCreateUser({ email, password, fullName, role }).
// Creates the auth.users row (service role) + the matching profiles row in
// one call. Re-checks the caller's role server-side — never trusts the
// client-side canManageRole() check in data.js/users.js.
//
// BUG FIX: the profiles row is now upserted instead of inserted. This
// project has a DB trigger on auth.users that auto-provisions a baseline
// profiles row the moment a new auth user is created (see 0001_init.sql /
// 0002_notifications.sql), so by the time this function ran its own
// .insert(), a row with that id already existed — causing a
// "duplicate key value violates unique constraint profiles_pkey" error.
// Upserting on id means this works whether or not that trigger fires, and
// it overwrites the trigger's defaults with the real full_name/role/email
// supplied by the admin creating this user.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ROLE_LEVELS: Record<string, number> = { employee: 1, admin: 2, super_admin: 3 };
const VALID_ROLES = ["employee", "admin", "super_admin"];
function roleLevel(r: string) {
  return ROLE_LEVELS[r] ?? 0;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function fail(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return fail("Missing Authorization header.", 401);

    // Client scoped to the caller's own JWT — used only to find out who is
    // calling. Never used to perform the privileged write itself.
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser();
    if (callerErr || !caller) return fail("Not authenticated.", 401);

    // Service-role client for every privileged read/write below.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: callerProfile, error: callerProfileErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();
    if (callerProfileErr || !callerProfile) return fail("Caller profile not found.", 403);

    const actingRole = callerProfile.role as string;
    if (actingRole !== "admin" && actingRole !== "super_admin") {
      return fail("Only admins can create users.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const { email, password, fullName, role } = body;

    if (!email || !password || !fullName || !role) {
      return fail("email, password, fullName, and role are required.");
    }
    if (!VALID_ROLES.includes(role)) {
      return fail("Invalid role.");
    }
    if (typeof password !== "string" || password.length < 8) {
      return fail("Password must be at least 8 characters.");
    }

    // Hierarchy: acting role must strictly outrank the role being granted.
    // (An admin can create employees but not admins or super_admins; only a
    // super_admin can create an admin or another super_admin.)
    if (roleLevel(actingRole) <= roleLevel(role)) {
      return fail("You don't have permission to create a user with this role.", 403);
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: { full_name: fullName },
    });
    if (createErr) return fail(createErr.message, 400);

    // BUG FIX: upsert instead of insert — a DB trigger on auth.users may
    // already have created a baseline profiles row for this id, and a plain
    // .insert() would collide with it (profiles_pkey violation). Upserting
    // on id guarantees the row ends up with the real values regardless of
    // whether the trigger ran first.
    const { error: upsertErr } = await admin
      .from("profiles")
      .upsert(
        {
          id: created.user.id,
          email,
          full_name: fullName,
          role,
        },
        { onConflict: "id" }
      );

    if (upsertErr) {
      // Roll back the auth user so we don't leave an orphaned account with
      // no correct profile row.
      await admin.auth.admin.deleteUser(created.user.id);
      return fail(upsertErr.message, 400);
    }

    return new Response(JSON.stringify({ user: created.user }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unexpected error.", 500);
  }
});