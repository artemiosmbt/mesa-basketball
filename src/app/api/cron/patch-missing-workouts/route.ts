import { NextRequest, NextResponse } from "next/server";

// Temporary one-off route: patches future private session calendar events
// that are missing the 15-min workout block template.

const TIMEZONE = "America/New_York";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(email: string, pemRaw: string): Promise<string> {
  const pem = pemRaw.replace(/\\n/g, "\n");
  const pemBody = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const derBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", derBuffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj: object) => { const j = JSON.stringify(obj); const b = new TextEncoder().encode(j); return base64url(b); };
  const header = enc({ alg: "RS256", typ: "JWT" });
  const claims = enc({ iss: email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now });
  const sig = base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`))));
  const jwt = `${header}.${claims}.${sig}`;
  const resp = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const json = await resp.json();
  return json.access_token as string;
}

function formatBlockTime(totalMins: number): string {
  let h = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function generateWorkoutTemplate(startISO: string, endISO: string): string {
  // startISO / endISO are like "2026-07-02T16:00:00-04:00"
  const toMins = (iso: string) => {
    const d = new Date(iso);
    const et = new Date(d.toLocaleString("en-US", { timeZone: TIMEZONE }));
    return et.getHours() * 60 + et.getMinutes();
  };
  const startMins = toMins(startISO);
  const endMins = toMins(endISO);
  if (endMins <= startMins) return "";
  const blocks: string[] = [];
  for (let t = startMins; t < endMins; t += 15) {
    if (blocks.length > 0) blocks.push("");
    blocks.push(`${formatBlockTime(t)}-${formatBlockTime(Math.min(t + 15, endMins))}`);
  }
  return blocks.join("\n");
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) {
    return NextResponse.json({ error: "Missing Google Calendar env vars" }, { status: 500 });
  }

  const token = await getAccessToken(saEmail, privateKey);

  // Fetch all events from today forward
  const today = new Date().toISOString().split("T")[0];
  const future = new Date(); future.setDate(future.getDate() + 60);
  const futureStr = future.toISOString().split("T")[0];
  const url = `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(today + "T00:00:00Z")}&timeMax=${encodeURIComponent(futureStr + "T23:59:59Z")}&singleEvents=true&maxResults=200`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  const items: Array<{ id: string; summary?: string; description?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }> = data.items || [];

  // Only private events (tagged [mesa-private:...]) that don't already have workout blocks
  const topatch = items.filter((ev) => {
    if (!ev.description?.includes("[mesa-private:")) return false;
    // Has a workout block already if description contains a time-range line like "4:00-4:15"
    if (/\d+:\d+-\d+:\d+/.test(ev.description)) return false;
    return true;
  });

  let patched = 0;
  const errors: string[] = [];
  for (const ev of topatch) {
    const workoutSection = ev.start?.dateTime && ev.end?.dateTime
      ? generateWorkoutTemplate(ev.start.dateTime, ev.end.dateTime)
      : "";
    if (!workoutSection) continue;

    // Insert workout blocks between "Location: ...\n\n" and "[mesa-private:"
    const newDescription = ev.description!.replace(
      /(Location:[^\n]*\n\n)([\s\S]*?)(\[mesa-private:)/,
      `$1${workoutSection}\n\n$3`
    );
    if (newDescription === ev.description) continue;

    const patchResp = await fetch(
      `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${ev.id}`,
      { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ description: newDescription }) }
    );
    if (patchResp.ok) {
      patched++;
    } else {
      errors.push(`${ev.summary}: ${await patchResp.text()}`);
    }
  }

  return NextResponse.json({ patched, skipped: topatch.length - patched, errors });
}
