import { NextRequest, NextResponse } from "next/server";

// One-off: retroactively strip the old 15-min workout-block template from
// future group/camp calendar events (the feature was removed going forward,
// but already-created events keep their old description until re-patched).
// Only touches events that (a) are still in the future and (b) still contain
// the untouched blank block template — never edits events where real notes
// may have been written in.

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

function base64url(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(saEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: saEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  );
  const signingInput = `${header}.${claims}`;
  const { createSign } = await import("node:crypto");
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = base64url(signer.sign(privateKeyPem.replace(/\\n/g, "\n")));
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

function stripBlankTemplate(description: string): string | null {
  const match = description.match(/(Location:[^\n]*\n\n)([\s\S]*?)\n\n(\[mesa-session:)/);
  if (!match) return null;
  const [full, locationPrefix, blockSection, tagPrefix] = match;
  const lines = blockSection.split("\n");
  const isBlankTemplate = lines.every(
    (line) => line === "" || /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(line)
  );
  if (!isBlankTemplate) return null;
  return description.replace(full, `${locationPrefix}${tagPrefix}`);
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token || token !== process.env.WORKOUT_CLEANUP_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) {
    return NextResponse.json({ error: "Calendar env vars not set" }, { status: 500 });
  }

  const accessToken = await getAccessToken(saEmail, privateKey);

  const timeMin = encodeURIComponent(new Date().toISOString());
  const future = new Date();
  future.setDate(future.getDate() + 180);
  const timeMax = encodeURIComponent(future.toISOString());
  const baseUrl =
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=500`;

  const items: Array<{ id: string; summary?: string; description?: string; etag?: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return NextResponse.json({ error: `list failed: ${resp.status}` }, { status: 500 });
    const data = await resp.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const patchedSummaries: string[] = [];
  let skipped = 0;

  for (const ev of items) {
    if (!ev.summary || !(ev.summary.startsWith("Group —") || ev.summary.startsWith("Camp —"))) continue;
    if (!ev.description || !ev.description.includes("[mesa-session:")) continue;
    const newDescription = stripBlankTemplate(ev.description);
    if (!newDescription) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      const resp = await fetch(`${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${ev.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(ev.etag ? { "If-Match": ev.etag } : {}),
        },
        body: JSON.stringify({ description: newDescription }),
      });
      if (!resp.ok) {
        return NextResponse.json(
          { error: `patch failed for ${ev.id}: ${resp.status} ${await resp.text()}`, patchedSoFar: patchedSummaries },
          { status: 500 }
        );
      }
    }
    patchedSummaries.push(ev.summary);
  }

  return NextResponse.json({
    dryRun,
    patched: patchedSummaries.length,
    patchedSummaries,
    skipped,
  });
}
