// ============================================================================
// Supabase Client Configuration
// ----------------------------------------------------------------------------
// Fill in SUPABASE_URL and SUPABASE_ANON_KEY with your project's credentials
// (Supabase Dashboard → Project Settings → API). These are public/anon values
// safe for client-side use when Row Level Security is enabled on your tables.
// ============================================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const SUPABASE_URL = "https://yqxropanteefpyfwjglt.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_mtn6TKu76ZT8DEhRHYpeIw_KYzdxq7D";

// True once real credentials are added. Other modules use this to avoid
// calling the Supabase client before it is configured.
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase credentials are not configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in js/supabase.js to enable authentication."
  );
}

// ----------------------------------------------------------------------------
// Storage adapter that honors the user's "Remember me" choice.
// When remembered, the session is persisted in localStorage (survives browser
// restarts). Otherwise it is kept in sessionStorage (cleared when the tab or
// browser closes). The flag is set by login.js before authentication.
// ----------------------------------------------------------------------------
export const REMEMBER_ME_FLAG_KEY = "whms-remember-me";

const rememberAwareStorage = {
  // Read from the same storage `setItem` just wrote to (based on the live
  // flag), falling back to the other storage only if that one is empty.
  getItem(key) {
    const remember = localStorage.getItem(REMEMBER_ME_FLAG_KEY) === "true";
    const primary = remember ? localStorage : sessionStorage;
    const secondary = remember ? sessionStorage : localStorage;
    return primary.getItem(key) ?? secondary.getItem(key);
  },
  setItem(key, value) {
    const remember = localStorage.getItem(REMEMBER_ME_FLAG_KEY) === "true";
    if (remember) {
      sessionStorage.removeItem(key);
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
      sessionStorage.setItem(key, value);
    }
  },
  removeItem(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

// createClient() throws on an invalid/empty URL, so it is only constructed
// once real credentials are present. Until then, `supabase` is null and
// auth.js falls back to safe no-op behavior instead of crashing the app.
export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: rememberAwareStorage,
      },
    })
  : null;

// ----------------------------------------------------------------------------
// Edge Function helper
// ----------------------------------------------------------------------------
// Every privileged admin action (creating a user, deleting a user, changing a
// role) needs the Supabase service-role key, which must never be shipped to
// the browser. Those actions are delegated to Supabase Edge Functions —
// small server-side handlers that live in your Supabase project under
// supabase/functions/<name>/index.ts and are deployed with:
//   supabase functions deploy <name>
//
// This helper does NOT contain the Edge Function code itself (that can't run
// in the browser). It just gives every caller in data.js one consistent way
// to invoke a deployed Edge Function and unwrap its result/errors, instead of
// repeating the same try/catch logic in three different places.
//
// Requires these Edge Functions to already be deployed to this Supabase
// project: "admin-create-user", "admin-delete-user", "admin-update-user-role".
// ----------------------------------------------------------------------------
export async function invokeEdgeFunction(name, body) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase is not configured yet.");
  }

  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    // BUG FIX: supabase-js's FunctionsHttpError.message is ALWAYS the
    // generic "Edge Function returned a non-2xx status code" for any
    // non-2xx response — it never contains the real { error: "..." } JSON
    // body our Edge Functions return via fail(). That real body only lives
    // on error.context, which is the raw Response object from the fetch
    // call. It has to be read and parsed manually, otherwise every failure
    // (bad password, missing profile, permission denied, etc.) shows the
    // exact same unhelpful generic toast, which is what was happening here.
    let message = error.message || `The "${name}" function failed.`;

    if (error.context && typeof error.context.json === "function") {
      try {
        const body = await error.context.json();
        if (body?.error) {
          message = body.error;
        }
      } catch {
        // error.context wasn't valid JSON (e.g. a network/relay-level
        // failure before our function code even ran) — keep the generic
        // message as a fallback instead of throwing here.
      }
    }

    throw new Error(message);
  }
  if (data?.error) {
    throw new Error(data.error);
  }

  return data;
}