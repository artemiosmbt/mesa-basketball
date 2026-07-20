export interface WeeklySession {
  group: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  maxSpots: number;
  price: number;
  trainer?: string;
}

export interface Camp {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  time: string;
  location: string;
  maxSpots: number;
  currentEnrolled: number;
  price: string;
  description: string;
  notify: boolean;
  // multi-group camp fields (optional — col K-N)
  gradeGroup: string;
  earlyBirdPrice: string;
  dropInPrice: string;
  campDays: string[];
}

export interface PrivateSlot {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  available: boolean;
  trainer: string;
}

function parseCSV(text: string): string[][] {
  const lines = text.trim().split("\n");
  return lines.map((line) => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

export async function getWeeklySchedule(options?: { noCache?: boolean }): Promise<WeeklySession[]> {
  const url = process.env.SHEET_CSV_WEEKLY_SCHEDULE;
  if (!url) return [];
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  // Skip header row
  return rows.slice(1).map((row) => ({
    group: row[0] || "",
    date: row[1] || "",
    startTime: row[2] || "",
    endTime: row[3] || "",
    location: row[4] || "",
    maxSpots: parseInt(row[5]) || 8,
    price: parseInt(row[6]) || 50,
    // Column H (index 7) is "Day of Week"; column I (index 8) is the optional
    // Trainer column — defaults to Artemios when not filled in.
    trainer: (row[8] || "").trim() || "Artemios Gavalas",
  }));
}

export async function getCamps(options?: { noCache?: boolean }): Promise<Camp[]> {
  const url = process.env.SHEET_CSV_CAMPS;
  if (!url) return [];
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  return rows.slice(1).map((row, i) => ({
    id: `camp-${i}`,
    name: row[0] || "",
    startDate: row[1] || "",
    endDate: row[2] || "",
    time: row[3] || "",
    location: row[4] || "",
    maxSpots: parseInt(row[5]) || 20,
    currentEnrolled: parseInt(row[6]) || 0,
    price: row[7] || "",
    description: row[8] || "",
    notify: (row[9] || "").toUpperCase() === "TRUE",
    gradeGroup: row[10] || "",
    earlyBirdPrice: row[11] || "",
    dropInPrice: row[12] || "",
    campDays: row[13] ? row[13].split("|").map((d) => d.trim()).filter(Boolean) : [],
  })).filter((camp) => camp.name);
}

export async function getPrivateSlots(options?: { noCache?: boolean }): Promise<PrivateSlot[]> {
  const url = process.env.SHEET_CSV_PRIVATE_SLOTS;
  if (!url) return [];
  const fetchOptions = options?.noCache
    ? { cache: "no-store" as const }
    : { next: { revalidate: 60 } };
  const res = await fetch(url, fetchOptions);
  const rows = parseCSV(await res.text());
  return rows.slice(1).map((row, i) => ({
    id: `slot-${i}`,
    date: row[0] || "",
    startTime: row[1] || "",
    endTime: row[2] || "",
    location: row[3] || "",
    available: (row[4] || "").toUpperCase() === "TRUE",
    // Column F (index 5) is "Day of Week"; column G (index 6) is the optional
    // Trainer column — defaults to Artemios when not filled in.
    trainer: (row[6] || "").trim() || "Artemios Gavalas",
  }));
}

// Returns the current location for a session from Google Sheets, or null if not found / unchanged.
export async function getCurrentSheetLocation(date: string, startTime: string): Promise<string | null> {
  const [weeklySessions, privateSlots] = await Promise.all([
    getWeeklySchedule().catch(() => []),
    getPrivateSlots().catch(() => []),
  ]);
  for (const s of [...weeklySessions, ...privateSlots]) {
    if (s.date === date && s.startTime === startTime) return s.location;
  }
  return null;
}
