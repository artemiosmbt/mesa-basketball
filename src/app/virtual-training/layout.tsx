import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Virtual Training | Mesa Basketball Training",
  description:
    "Train on your own time with Mesa Basketball's online workout library. New content added weekly. Monthly, 6-month, and yearly plans available.",
};

export default function VirtualTrainingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
