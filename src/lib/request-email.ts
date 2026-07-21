import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRegistrationByToken } from "@/lib/supabase";

// Resolves the email a credit/package-balance lookup should run against —
// never trust a client-supplied ?email= directly, since that would let
// anyone enumerate another client's balance. Two legitimate callers exist:
// a logged-in user checking their own balance (Bearer session token), and
// the token-gated booking-management page checking the balance tied to
// that specific booking (manage_token possession, no login).
export async function resolveRequestEmail(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization")?.replace("Bearer ", "");
  if (authHeader) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { data: { user } } = await supabase.auth.getUser(authHeader);
    if (user?.email) return user.email.toLowerCase().trim();
  }

  const bookingToken = req.nextUrl.searchParams.get("token");
  if (bookingToken) {
    const reg = await getRegistrationByToken(bookingToken);
    if (reg?.email) return reg.email.toLowerCase().trim();
  }

  return null;
}
