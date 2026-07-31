// ============================================================================
// Edge Function: admin-delete-user
// ----------------------------------------------------------------------------
// Called by js/data.js's adminDeleteUser(id, { actingRole, targetRole }).
// The actingRole/targetRole the client sends are NOT trusted — they're only
// used client-side for UI disabling. Here we look both roles up ourselves
// from the DB before doing anything.
// Deleting the auth.users row cascades to profiles via
// "references auth.users (id) on delete cascade", so no separate profile
// delete is needed.
//
// SECURITY NOTE: SUPABASE_SERVICE_ROLE_KEY is read from an environment
// secret — never hardcode it here or commit it to source control. If it's
// ever exposed, rotate it from
// Project Settings → Data API → Project API Keys → service_role → Regenerate.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ROLE_LEVELS: Record<string, number> = { employee: 1, admin: 2, super_admin: 3 };
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
      return fail("Only admins can delete users.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return fail("id is required.");
    if (id === caller.id) return fail("You can't delete your own account.", 403);

    const { data: targetProfile, error: targetErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", id)
      .single();
    if (targetErr || !targetProfile) return fail("Target user not found.", 404);

    if (roleLevel(actingRole) <= roleLevel(targetProfile.role as string)) {
      return fail("You don't have permission to delete this user.", 403);
    }

    const { error: deleteErr } = await admin.auth.admin.deleteUser(id);
    if (deleteErr) return fail(deleteErr.message, 400);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unexpected error.", 500);
  }
});