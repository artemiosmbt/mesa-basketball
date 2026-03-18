import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification } from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { parentName, email, phone, kids, type, sessionDetails, totalParticipants } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Send emails to Artemi + confirmation to parent
    await sendRegistrationNotification({
      parentName,
      email,
      phone,
      kids,
      type,
      sessionDetails,
      totalParticipants: totalParticipants || 1,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 }
    );
  }
}
