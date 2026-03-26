import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Schedule & Programs | Mesa Basketball Training",
  description:
    "Browse and register for basketball training sessions on Long Island. Group sessions, private lessons, and mini camps for all ages and skill levels.",
  keywords: [
    "basketball training schedule Long Island",
    "basketball sessions Long Island",
    "register basketball camp Long Island",
    "youth basketball programs Long Island",
    "private basketball training sessions",
    "basketball group training Long Island",
  ],
  openGraph: {
    title: "Schedule & Programs | Mesa Basketball Training",
    description: "Browse and register for basketball training sessions on Long Island. Group sessions, private lessons, and mini camps.",
    url: "https://www.mesabasketballtraining.com/schedule",
    images: [{ url: "/og-image.jpg", width: 1200, height: 630 }],
  },
};

export default function ScheduleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
