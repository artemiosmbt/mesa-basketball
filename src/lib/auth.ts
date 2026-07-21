import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

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

// Login/signup redirect via ?next= must only ever go to a path on this same
// site — an unchecked value lets an attacker send
// `/login?next=https://evil.example.com`, so a victim logs in for real on
// the legitimate domain and is then bounced straight to a phishing page
// right after a trusted auth flow. Only a same-origin relative path
// (leading "/", never "//" which browsers treat as protocol-relative to
// another host) is allowed; anything else falls back to "/".
export function safeRedirectPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

// Shared admin check for every /api/admin/* route — every route must call
// this before any mutation. Previously each route redeclared its own
// near-identical copy (some checking a fresh client, some the shared
// authClient), which risked a future copy-paste drifting into a route that
// forgets the check entirely.
export async function verifyAdmin(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const { data: { user } } = await authClient.auth.getUser(token);
  return user?.email === ADMIN_EMAIL;
}
