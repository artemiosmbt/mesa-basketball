import type { Metadata } from "next";

// Unlisted page — only coaches with the link. Kept out of search engines.
export const metadata: Metadata = {
  title: "St. Paul's Team Practices",
  robots: { index: false, follow: false },
};

export default function StPaulsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
