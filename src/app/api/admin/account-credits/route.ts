import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { addAccountCredit, deductAccountCredit, setAccountCreditBalance } from "@/lib/supabase";

// Manual balance adjustment — positive amount adds credit, negative removes it.
// setBalance is a separate absolute override (used by the "edit balance to X"
// UI) computed server-side against the live balance, not a client-supplied delta.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email, amount, setBalance } = await req.json();
  if (!email) {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }
  const trimmedEmail = String(email).toLowerCase().trim();

  if (typeof setBalance === "number") {
    if (setBalance < 0) {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
    }
    await setAccountCreditBalance(trimmedEmail, Math.round(setBalance * 100) / 100);
    return NextResponse.json({ ok: true });
  }

  if (typeof amount !== "number" || amount === 0) {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }
  if (amount > 0) {
    await addAccountCredit(trimmedEmail, amount);
  } else {
    const success = await deductAccountCredit(trimmedEmail, -amount);
    if (!success) {
      return NextResponse.json({ error: "Insufficient balance to remove that much credit" }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true });
}
