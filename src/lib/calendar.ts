/**
 * Google Calendar integration using the REST API with JWT (service account) auth.
 * No external packages — uses fetch only.
 */

// ---------------------------------------------------------------------------
// JWT / token helpers
// ---------------------------------------------------------------------------

/** Base64url-encode a Uint8Array */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode an object as a base64url JSON string */
function encodeJwtPart(obj: object): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return base64url(bytes);
}

/**
 * Import the RSA private key from a PEM string.
 * The key may arrive with literal \n sequences (as stored in env vars).
 */
async function importPrivateKey(pemRaw: string): Promise<CryptoKey> {
  const pem = pemRaw.replace(/\\n/g, "\n");
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const derBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    derBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/** Create a signed JWT for the Google service account */
async function createJwt(serviceAccountEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
  const claims = encodeJwtPart({
    iss: serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });

  const signingInput = `${header}.${claims}`;
  const key = await importPrivateKey(privateKeyPem);
  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const signature = base64url(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signature}`;
}

/** Exchange a signed JWT for an OAuth2 access token */
async function getAccessToken(serviceAccountEmail: string, privateKeyPem: string): Promise<string> {
  const jwt = await createJwt(serviceAccountEmail, privateKeyPem);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get access token: ${resp.status} ${text}`);
  }
  const json = await resp.json();
  return json.access_token as string;
}

// ---------------------------------------------------------------------------
// Google Calendar REST helpers
// ---------------------------------------------------------------------------

interface CalendarEvent {
  id?: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

const TIMEZONE = "America/New_York";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * Normalize any date string to YYYY-MM-DD for the Calendar API.
 * Handles "March 20, 2026", "2026-03-20", "3/20/2026", etc.
 */
function normalizeDate(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return dateStr;
}

/**
 * Convert a date string (any format) and a time string (HH:MM or H:MM AM/PM)
 * into a full ISO-8601 dateTime string for the Calendar API.
 */
function toDateTime(date: string, time: string): string {
  // Normalise time — accept "9:00 AM", "09:00", "9:00am", etc.
  const cleaned = time.trim();
  let hours = 0;
  let minutes = 0;

  const ampm = cleaned.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (ampm) {
    hours = parseInt(ampm[1], 10);
    minutes = parseInt(ampm[2], 10);
    const meridiem = ampm[3].toLowerCase();
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else {
    const plain = cleaned.match(/^(\d{1,2}):(\d{2})$/);
    if (plain) {
      hours = parseInt(plain[1], 10);
      minutes = parseInt(plain[2], 10);
    }
  }

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${normalizeDate(date)}T${hh}:${mm}:00`;
}

/**
 * Search for an existing calendar event on a given day (timeMin/timeMax window)
 * whose description contains a specific tag string.
 * Returns the event id if found, otherwise null.
 */
async function findExistingEvent(
  calendarId: string,
  token: string,
  date: string,
  tag: string
): Promise<{ id: string; description: string } | null> {
  const isoDate = normalizeDate(date);
  const timeMin = encodeURIComponent(`${isoDate}T00:00:00Z`);
  const timeMax = encodeURIComponent(`${isoDate}T23:59:59Z`);
  const url =
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=50`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  const items: Array<{ id: string; description?: string; summary?: string }> =
    data.items || [];

  const match = items.find(
    (ev) =>
      (ev.description && ev.description.includes(tag)) ||
      (ev.summary && ev.summary.includes(tag))
  );
  return match ? { id: match.id, description: match.description || "" } : null;
}

/** Create a new calendar event; returns the created event id */
async function createEvent(
  calendarId: string,
  token: string,
  event: CalendarEvent
): Promise<string> {
  const resp = await fetch(
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create calendar event: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.id as string;
}

/** Delete a calendar event by id */
async function deleteEvent(calendarId: string, token: string, eventId: string): Promise<void> {
  await fetch(
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Fetch all future group session events (tagged with [mesa-session:...]) and
 * delete any whose tag is not in the provided set of expected tags.
 * Called by the calendar-sync cron to clean up stale events after schedule changes.
 */
export async function deleteStaleGroupSessionEvents(
  expectedTags: Set<string>
): Promise<{ deleted: number }> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) return { deleted: 0 };

  const token = await getAccessToken(saEmail, privateKey);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const future = new Date();
  future.setDate(future.getDate() + 120);
  const futureStr = future.toISOString().split("T")[0];

  const timeMin = encodeURIComponent(`${today}T00:00:00Z`);
  const timeMax = encodeURIComponent(`${futureStr}T23:59:59Z`);
  const url =
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=500`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return { deleted: 0 };

  const data = await resp.json();
  const items: Array<{ id: string; description?: string }> = data.items || [];

  let deleted = 0;
  for (const item of items) {
    if (!item.description) continue;
    const match = item.description.match(/\[mesa-session:[^\]]+\]/);
    if (!match) continue;
    const tag = match[0];
    if (!expectedTags.has(tag)) {
      await deleteEvent(calendarId, token, item.id);
      deleted++;
    }
  }

  return { deleted };
}

/** Patch an existing calendar event's description (and optionally summary) */
async function patchEvent(
  calendarId: string,
  token: string,
  eventId: string,
  patch: Partial<Pick<CalendarEvent, "summary" | "description">>
): Promise<void> {
  const resp = await fetch(
    `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to patch calendar event: ${resp.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Supabase query helper (inline — avoids importing the full supabase client
// just to run two reads)
// ---------------------------------------------------------------------------

interface RegistrationRow {
  kids: string;
  total_participants: number;
}

async function getSessionRegistrations(
  date: string,
  startTime: string,
  sessionType: "weekly" | "camp"
): Promise<RegistrationRow[]> {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("registrations")
    .select("kids, total_participants")
    .eq("type", sessionType)
    .eq("status", "confirmed")
    .eq("booked_date", date)
    .eq("booked_start_time", startTime);

  if (error || !data) return [];
  return data as RegistrationRow[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PrivateSessionParams {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  bookedDate: string;       // YYYY-MM-DD
  bookedStartTime: string;  // e.g. "10:00 AM"
  bookedEndTime: string;
  bookedLocation: string;
}

export interface GroupSessionParams {
  sessionType: "weekly" | "camp";
  sessionLabel: string;    // e.g. "Grades 3-5 Group", "Summer Camp"
  bookedDate: string;
  bookedStartTime: string;
  bookedEndTime: string;
  bookedLocation: string;
  maxSpots?: number;
  // The newly registered athlete's kids string (used in signup list)
  kidsJustRegistered: string;
  participantsJustRegistered: number;
}

/**
 * Create a private session calendar event for Artemios.
 * Fire-and-forget — call without await or catch at the call site.
 */
export async function addPrivateSessionToCalendar(
  params: PrivateSessionParams
): Promise<void> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) {
    console.warn("Google Calendar env vars not set — skipping calendar sync");
    return;
  }

  const token = await getAccessToken(saEmail, privateKey);

  const summary = `Private — ${params.parentName} (${params.kids})`;
  const tag = `[mesa-private:${params.bookedDate}|${params.email}]`;
  const description = [
    `Parent: ${params.parentName}`,
    `Email: ${params.email}`,
    `Phone: ${params.phone}`,
    `Athletes: ${params.kids}`,
    `Location: ${params.bookedLocation}`,
    "",
    tag,
  ].join("\n");

  const event: CalendarEvent = {
    summary,
    description,
    start: { dateTime: toDateTime(params.bookedDate, params.bookedStartTime), timeZone: TIMEZONE },
    end:   { dateTime: toDateTime(params.bookedDate, params.bookedEndTime),   timeZone: TIMEZONE },
  };

  await createEvent(calendarId, token, event);
}

/** Delete a private session calendar event when a booking is cancelled */
export async function deletePrivateSessionFromCalendar(params: {
  email: string;
  bookedDate: string;
}): Promise<void> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) return;

  const token = await getAccessToken(saEmail, privateKey);
  const tag = `[mesa-private:${params.bookedDate}|${params.email}]`;
  const existing = await findExistingEvent(calendarId, token, params.bookedDate, tag);
  if (existing) {
    await deleteEvent(calendarId, token, existing.id);
  }
}

/**
 * Upsert a group/camp session calendar event.
 * Finds an existing event for the same date+startTime (matched by a tag in the
 * description) and updates the signup count, or creates a new event.
 * Fire-and-forget — call without await or catch at the call site.
 */
export async function upsertGroupSessionCalendarEvent(
  params: GroupSessionParams
): Promise<void> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!calendarId || !saEmail || !privateKey) {
    console.warn("Google Calendar env vars not set — skipping calendar sync");
    return;
  }

  // Never touch past events — prevents re-creating deleted events and avoids
  // creating duplicates when manually-edited Apple Calendar notes wipe the tag.
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (normalizeDate(params.bookedDate) < todayStr) return;

  const token = await getAccessToken(saEmail, privateKey);

  // A stable tag embedded in the description so we can find the event later.
  const tag = `[mesa-session:${params.bookedDate}|${params.bookedStartTime}]`;

  // Fetch current signup list from Supabase (includes the row just inserted).
  const rows = await getSessionRegistrations(
    params.bookedDate,
    params.bookedStartTime,
    params.sessionType
  );

  const totalSignedUp = rows.reduce((sum, r) => sum + (r.total_participants || 1), 0);
  const athleteNames = rows.map((r) => r.kids).filter(Boolean).join(", ");

  const countLine = params.maxSpots
    ? `${totalSignedUp}/${params.maxSpots} signed up`
    : `${totalSignedUp} signed up`;

  const summary =
    params.sessionType === "camp"
      ? `Camp — ${params.sessionLabel} (${params.bookedDate})`
      : `Group — ${params.sessionLabel} (${params.bookedDate})`;

  const description = [
    countLine,
    `Athletes: ${athleteNames}`,
    `Location: ${params.bookedLocation}`,
    "",
    tag,
  ].join("\n");

  const existing = await findExistingEvent(calendarId, token, params.bookedDate, tag);

  if (existing) {
    await patchEvent(calendarId, token, existing.id, { description });
  } else if (totalSignedUp > 0) {
    // Only create a new event if someone is actually registered — avoids
    // re-creating events the user deleted because no one showed up.
    const event: CalendarEvent = {
      summary,
      description,
      start: { dateTime: toDateTime(params.bookedDate, params.bookedStartTime), timeZone: TIMEZONE },
      end:   { dateTime: toDateTime(params.bookedDate, params.bookedEndTime),   timeZone: TIMEZONE },
    };
    await createEvent(calendarId, token, event);
  }
}
