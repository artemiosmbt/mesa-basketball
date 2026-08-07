/**
 * Google Sheets write access using the REST API with JWT (service account) auth.
 * Mirrors calendar.ts's auth pattern exactly (same service account, different
 * OAuth scope) but is kept fully self-contained rather than sharing code with
 * calendar.ts, so nothing here can ever affect the working calendar sync.
 * No external packages — uses fetch only.
 */

// ---------------------------------------------------------------------------
// JWT / token helpers (scoped to Sheets, not Calendar)
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJwtPart(obj: object): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return base64url(bytes);
}

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

async function createJwt(serviceAccountEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
  const claims = encodeJwtPart({
    iss: serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
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

// Separate cache from calendar.ts's — different OAuth scope means a
// different token, so these must never be shared.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(serviceAccountEmail: string, privateKeyPem: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

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
    throw new Error(`Failed to get Sheets access token: ${resp.status} ${text}`);
  }
  const json = await resp.json();
  const token = json.access_token as string;
  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  cachedToken = { token, expiresAt: Date.now() + (expiresInSec - 60) * 1000 };
  return token;
}

async function getToken(): Promise<string> {
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!saEmail || !privateKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY not configured");
  }
  return getAccessToken(saEmail, privateKey);
}

// ---------------------------------------------------------------------------
// Sheets REST helpers
// ---------------------------------------------------------------------------

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** Quote a sheet/tab name for use in an A1-notation range if it contains spaces or special chars. */
export function a1Quote(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

/** Read a range of values. Returns [] if the range is entirely empty. */
export async function getValues(spreadsheetId: string, range: string): Promise<unknown[][]> {
  const token = await getToken();
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`Sheets values.get failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
  const json = await resp.json();
  return json.values || [];
}

/** Overwrite a range with the given 2D array of values (row-major). */
export async function updateValues(
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<void> {
  const token = await getToken();
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  if (!resp.ok) {
    throw new Error(`Sheets values.update failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
}

/** Append rows after the last row of a table (used only for the hidden _SyncLog tab). */
export async function appendValues(
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<void> {
  const token = await getToken();
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  if (!resp.ok) {
    throw new Error(`Sheets values.append failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
}

interface SheetMeta {
  sheetId: number;
  title: string;
}

/** List every tab's sheetId + title — needed because copyPaste requests address tabs by numeric sheetId, not name. */
export async function getSheetMeta(spreadsheetId: string): Promise<SheetMeta[]> {
  const token = await getToken();
  const url = `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`Sheets get (metadata) failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
  const json = await resp.json();
  return (json.sheets || []).map((s: { properties: SheetMeta }) => s.properties);
}

/** Run an arbitrary batchUpdate — used for copyPaste (row cloning) and addSheet (creating _SyncLog). */
export async function batchUpdate(spreadsheetId: string, requests: object[]): Promise<void> {
  const token = await getToken();
  const url = `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) {
    throw new Error(`Sheets batchUpdate failed (${resp.status}): ${await resp.text().catch(() => "")}`);
  }
}

/**
 * Clone one full row (formulas, formatting, data validation, conditional-
 * formatting membership — everything) onto another row, exactly like a
 * human selecting the source row, copying it, and pasting it onto the
 * destination row. This is how new trainer-tab rows pick up all the
 * formula/dropdown/color infrastructure that only row 4 was built with.
 */
export async function copyRow(
  spreadsheetId: string,
  sheetId: number,
  sourceRow1Indexed: number,
  destRow1Indexed: number,
  numColumns: number
): Promise<void> {
  await batchUpdate(spreadsheetId, [
    {
      copyPaste: {
        source: {
          sheetId,
          startRowIndex: sourceRow1Indexed - 1,
          endRowIndex: sourceRow1Indexed,
          startColumnIndex: 0,
          endColumnIndex: numColumns,
        },
        destination: {
          sheetId,
          startRowIndex: destRow1Indexed - 1,
          endRowIndex: destRow1Indexed,
          startColumnIndex: 0,
          endColumnIndex: numColumns,
        },
        pasteType: "PASTE_NORMAL",
      },
    },
  ]);
}
