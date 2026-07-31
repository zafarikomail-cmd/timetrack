// ============================================================================
// Edge Function: admin-update-user-role
// ----------------------------------------------------------------------------
// Called by js/data.js's adminUpdateUserRole(id, newRole, { actingRole,
// targetRole, fullName }). Body: { id, role?, fullName? } — role is now
// optional, since this function is also used to save a full_name edit for
// someone OTHER than the caller.
//
// BUG FIX: the Users page's "Edit User" modal used to call the plain client
// updateProfile(id, { full_name }) (anon key) for every name change,
// including edits to OTHER users. RLS on profiles only allows
// `auth.uid() = id`, so an admin editing someone else's name always matched
// zero rows under RLS and .select().single() then threw "Cannot coerce the
// result to a single JSON object" (PGRST116 — no error was raised by the
// UPDATE itself, it just silently matched nothing). Editing another user's
// name now goes through this service-role function instead, same as role
// changes already did.
//
// Why this must touch BOTH auth.users and profiles when the role changes
// (per the comment in data.js above this function): getUserRole() and every
// RLS policy ultimately read the role out of the JWT's app_metadata.role,
// which is only refreshed on token refresh / next login. profiles.role is
// what the UI displays and queries. If only one were updated they'd desync.
//
// SECURITY NOTE: SUPABASE_SERVICE_ROLE_KEY is read from an environment
// secret (auto-provided by Supabase to every deployed Edge Function) —
// never hardcode it here or commit it to source control. If it's ever
// exposed, rotate it from
// Project Settings → Data API → Project API Keys → service_role → Regenerate.
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

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser();
    if (callerErr || !caller) return fail("Not authenticated.", 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: callerProfile, error: callerProfileErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();
    if (callerProfileErr || !callerProfile) return fail("Caller profile not found.", 403);

    const actingRole = callerProfile.role as string;
    if (actingRole !== "admin" && actingRole !== "super_admin") {
      return fail("Only admins can update users.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const { id, role: newRole, fullName } = body;

    if (!id) return fail("id is required.");
    if (newRole === undefined && fullName === undefined) {
      return fail("Provide at least one of role or fullName to update.");
    }
    if (newRole !== undefined && !VALID_ROLES.includes(newRole)) {
      return fail("Invalid role.");
    }

    const isSelfEdit = id === caller.id;

    // Changing your OWN role is never allowed, regardless of hierarchy.
    // (Editing your own full_name is fine — that's the one case where we
    // skip the hierarchy check below.)
    if (newRole !== undefined && isSelfEdit) {
      return fail("You can't change your own role.", 403);
    }

    const { data: targetProfile, error: targetErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", id)
      .single();
    if (targetErr || !targetProfile) return fail("Target user not found.", 404);

    const targetRole = targetProfile.role as string;

    // Hierarchy check: acting role must strictly outrank the target's
    // CURRENT role for any edit to them (name or role). Skipped only for a
    // self full_name-only edit (isSelfEdit, no role change requested).
    if (!isSelfEdit && roleLevel(actingRole) <= roleLevel(targetRole)) {
      return fail("You don't have permission to edit this user.", 403);
    }

    if (newRole !== undefined) {
      // No one can grant a role equal to or higher than their own, except a
      // super_admin (who can grant anything, including super_admin).
      if (roleLevel(newRole) >= roleLevel(actingRole) && actingRole !== "super_admin") {
        return fail("You can't grant a role equal to or higher than your own.", 403);
      }
      if (newRole === "super_admin" && actingRole !== "super_admin") {
        return fail("Only a Super Admin can promote someone to Super Admin.", 403);
      }

      // 1. Update the JWT-backing app_metadata first.
      const { error: authUpdateErr } = await admin.auth.admin.updateUserById(id, {
        app_metadata: { role: newRole },
      });
      if (authUpdateErr) return fail(authUpdateErr.message, 400);
    }

    // 2. Update profiles (role and/or full_name). This uses the
    // service-role client, so the profiles_role_lock trigger's
    // `auth.role() <> 'service_role'` guard allows the role write through
    // (it only blocks role edits from a normal client).
    const patch: Record<string, unknown> = {};
    if (newRole !== undefined) patch.role = newRole;
    if (fullName !== undefined) patch.full_name = fullName;

    const { data: updatedProfile, error: profileUpdateErr } = await admin
      .from("profiles")
      .update(patch)
      .eq("id", id)
      .select()
      .single();

    if (profileUpdateErr) {
      if (newRole !== undefined) {
        // Roll back the app_metadata change so auth.users and profiles
        // don't end up disagreeing about this user's role.
        await admin.auth.admin.updateUserById(id, { app_metadata: { role: targetRole } });
      }
      return fail(profileUpdateErr.message, 400);
    }

    return new Response(JSON.stringify({ profile: updatedProfile }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unexpected error.", 500);
  }
});