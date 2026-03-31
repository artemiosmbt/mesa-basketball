import { NextResponse } from "next/server";

export async function GET() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  const envCheck = {
    GOOGLE_CALENDAR_ID: calendarId ? `set (${calendarId})` : "MISSING",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: saEmail ? `set (${saEmail})` : "MISSING",
    GOOGLE_PRIVATE_KEY: privateKey
      ? `set (${privateKey.length} chars, starts: ${privateKey.slice(0, 30)}...)`
      : "MISSING",
  };

  if (!calendarId || !saEmail || !privateKey) {
    return NextResponse.json({ error: "Missing env vars", envCheck });
  }

  try {
    // Test 1: Import the private key
    const pem = privateKey.replace(/\\n/g, "\n");
    const pemBody = pem
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");

    let key: CryptoKey;
    try {
      const derBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
      key = await crypto.subtle.importKey(
        "pkcs8",
        derBuffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      );
    } catch (keyErr) {
      return NextResponse.json({
        error: "Failed to import private key",
        detail: String(keyErr),
        envCheck,
        pemBodyLength: pemBody.length,
      });
    }

    // Test 2: Create JWT
    function base64url(bytes: Uint8Array): string {
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function encodeJwtPart(obj: object): string {
      return base64url(new TextEncoder().encode(JSON.stringify(obj)));
    }

    const now = Math.floor(Date.now() / 1000);
    const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
    const claims = encodeJwtPart({
      iss: saEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    });
    const signingInput = `${header}.${claims}`;
    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput)
    );
    const jwt = `${signingInput}.${base64url(new Uint8Array(signatureBuffer))}`;

    // Test 3: Exchange for access token
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) {
      return NextResponse.json({
        error: "Failed to get access token",
        status: tokenResp.status,
        detail: tokenText,
        envCheck,
      });
    }
    const tokenJson = JSON.parse(tokenText);
    const token = tokenJson.access_token as string;

    // Test 4: List calendars (verify access)
    const calResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const calText = await calResp.text();
    if (!calResp.ok) {
      return NextResponse.json({
        error: "Failed to access calendar",
        status: calResp.status,
        detail: calText,
        envCheck,
        tokenObtained: true,
      });
    }
    const calJson = JSON.parse(calText);

    // Test 5: Create a test event
    const today = new Date().toISOString().split("T")[0];
    const testEvent = {
      summary: "Mesa Calendar Test ✓",
      description: "Auto-test from Mesa Basketball site. Safe to delete.",
      start: { dateTime: `${today}T12:00:00`, timeZone: "America/New_York" },
      end:   { dateTime: `${today}T12:30:00`, timeZone: "America/New_York" },
    };
    const createResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(testEvent),
      }
    );
    const createText = await createResp.text();
    if (!createResp.ok) {
      return NextResponse.json({
        error: "Failed to create test event",
        status: createResp.status,
        detail: createText,
        calendarName: calJson.summary,
        envCheck,
        tokenObtained: true,
      });
    }
    const createdEvent = JSON.parse(createText);

    return NextResponse.json({
      success: true,
      message: "Calendar integration working! Test event created.",
      calendarName: calJson.summary,
      testEventId: createdEvent.id,
      testEventLink: createdEvent.htmlLink,
      envCheck,
    });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error", detail: String(err), envCheck });
  }
}
