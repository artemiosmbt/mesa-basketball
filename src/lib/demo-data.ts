import type { WeeklySession, Camp, PrivateSlot } from "./sheets";

export const demoWeeklySchedule: WeeklySession[] = [
  { group: "Junior Boys & Girls — Grade 5 & Below", day: "Monday", startTime: "5:00 PM", endTime: "6:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Junior Boys & Girls — Grade 5 & Below", day: "Wednesday", startTime: "5:00 PM", endTime: "6:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Junior Boys & Girls — Grade 5 & Below", day: "Saturday", startTime: "9:00 AM", endTime: "10:00 AM", location: "St. Pauls", maxSpots: 12 },

  { group: "Middle School Boys — Grades 5-8", day: "Monday", startTime: "6:00 PM", endTime: "7:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Middle School Boys — Grades 5-8", day: "Wednesday", startTime: "6:00 PM", endTime: "7:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Middle School Boys — Grades 5-8", day: "Saturday", startTime: "10:00 AM", endTime: "11:00 AM", location: "St. Pauls", maxSpots: 12 },

  { group: "Middle School Girls — Grades 5-8", day: "Monday", startTime: "7:00 PM", endTime: "8:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Middle School Girls — Grades 5-8", day: "Wednesday", startTime: "7:00 PM", endTime: "8:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "Middle School Girls — Grades 5-8", day: "Saturday", startTime: "11:00 AM", endTime: "12:00 PM", location: "St. Pauls", maxSpots: 12 },

  { group: "High School Girls — Grades 9-12", day: "Tuesday", startTime: "5:00 PM", endTime: "6:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "High School Girls — Grades 9-12", day: "Friday", startTime: "5:00 PM", endTime: "6:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "High School Girls — Grades 9-12", day: "Sunday", startTime: "2:30 PM", endTime: "3:30 PM", location: "Cherry Valley", maxSpots: 12 },

  { group: "High School Boys — Grades 9-12", day: "Tuesday", startTime: "6:00 PM", endTime: "7:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "High School Boys — Grades 9-12", day: "Friday", startTime: "6:00 PM", endTime: "7:00 PM", location: "St. Pauls", maxSpots: 12 },
  { group: "High School Boys — Grades 9-12", day: "Sunday", startTime: "3:30 PM", endTime: "4:30 PM", location: "Cherry Valley", maxSpots: 12 },
];

export const demoCamps: Camp[] = [
  {
    id: "camp-0",
    name: "Summer Skills Intensive",
    startDate: "June 23, 2026",
    endDate: "June 27, 2026",
    time: "9:00 AM - 12:00 PM",
    location: "St. Pauls",
    maxSpots: 20,
    currentEnrolled: 12,
    price: "$200",
    description: "Five days of intensive skill work — shooting, ball handling, footwork, and game situations. All skill levels welcome (grades 3-8).",
  },
  {
    id: "camp-1",
    name: "Spring Break Hoops Camp",
    startDate: "April 14, 2026",
    endDate: "April 16, 2026",
    time: "10:00 AM - 1:00 PM",
    location: "Cherry Valley",
    maxSpots: 20,
    currentEnrolled: 15,
    price: "$125",
    description: "Three-day camp focused on competitive drills and game IQ. Grades 5-12.",
  },
];

export const demoPrivateSlots: PrivateSlot[] = [
  { id: "slot-0", date: "March 22, 2026", startTime: "4:00 PM", endTime: "5:00 PM", location: "St. Pauls", available: true },
  { id: "slot-1", date: "March 23, 2026", startTime: "3:00 PM", endTime: "4:00 PM", location: "St. Pauls", available: true },
  { id: "slot-2", date: "March 25, 2026", startTime: "4:00 PM", endTime: "5:00 PM", location: "Cherry Valley", available: true },
  { id: "slot-3", date: "March 29, 2026", startTime: "10:00 AM", endTime: "11:00 AM", location: "St. Pauls", available: true },
  { id: "slot-4", date: "March 29, 2026", startTime: "3:00 PM", endTime: "3:45 PM", location: "St. Pauls", available: true },
  { id: "slot-5", date: "March 30, 2026", startTime: "2:00 PM", endTime: "3:00 PM", location: "St. Pauls", available: true },
];
