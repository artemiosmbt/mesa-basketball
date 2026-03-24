import { NextRequest, NextResponse } from "next/server";
import { enrollInPackage, getActivePackage } from "@/lib/supabase";
import { sendPackageConfirmation } from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { parentName, email, phone, packageType, monthYear, kids, referralCode } = body;

    if (!parentName || !email || !phone || !packageType || !monthYear) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (packageType !== 4 && packageType !== 8) {
      return NextResponse.json({ error: "Invalid package type. Must be 4 or 8." }, { status: 400 });
    }

    // Check if an active package already exists for this email + month
    const existing = await getActivePackage(email, monthYear);
    if (existing) {
      return NextResponse.json(
        { error: "You already have an active package for this month." },
        { status: 400 }
      );
    }

    const { id } = await enrollInPackage({ email, parentName, phone, packageType, monthYear });

    const totalPrice = packageType === 4 ? 475 : 900;

    await sendPackageConfirmation({ parentName, email, phone, packageType, monthYear, totalPrice, kids, referralCode });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("Package enrollment error:", error);
    return NextResponse.json({ error: "Enrollment failed. Please try again." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email");
    const monthYear = searchParams.get("monthYear");

    if (!email || !monthYear) {
      return NextResponse.json({ error: "email and monthYear are required" }, { status: 400 });
    }

    const pkg = await getActivePackage(email, monthYear);
    return NextResponse.json({ package: pkg });
  } catch (error) {
    console.error("Package lookup error:", error);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
