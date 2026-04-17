import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const ADMIN_EMAIL = "artemios@mesabasketballtraining.com";

let _client: SupabaseClient | null = null;

// Lazily initialized client for auth operations
export const authClient = {
  get auth() {
    if (!_client) {
      _client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { flowType: "implicit" } }
      );
    }
    return _client.auth;
  },
};
