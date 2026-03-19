export interface WeeklySession {
  group: string;
  day: string;
  startTime: string;
  endTime: string;
  location: string;
  maxSpots: number;
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
}

export interface PrivateSlot {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  available: boolean;
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

export async function getWeeklySchedule(): Promise<WeeklySession[]> {
  const url = process.env.SHEET_CSV_WEEKLY_SCHEDULE;
  if (!url) return [];
  const res = await fetch(url, { next: { revalidate: 60 } });
  const rows = parseCSV(await res.text());
  // Skip header row
  return rows.slice(1).map((row) => ({
    group: row[0] || "",
    day: row[1] || "",
    startTime: row[2] || "",
    endTime: row[3] || "",
    location: row[4] || "",
    maxSpots: parseInt(row[5]) || 12,
  }));
}

export async function getCamps(): Promise<Camp[]> {
  const url = process.env.SHEET_CSV_CAMPS;
  if (!url) return [];
  const res = await fetch(url, { next: { revalidate: 60 } });
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
  }));
}

export async function getPrivateSlots(): Promise<PrivateSlot[]> {
  const url = process.env.SHEET_CSV_PRIVATE_SLOTS;
  if (!url) return [];
  const res = await fetch(url, { next: { revalidate: 60 } });
  const rows = parseCSV(await res.text());
  return rows.slice(1).map((row, i) => ({
    id: `slot-${i}`,
    date: row[0] || "",
    startTime: row[1] || "",
    endTime: row[2] || "",
    location: row[3] || "",
    available: (row[4] || "").toUpperCase() === "TRUE",
  }));
}
