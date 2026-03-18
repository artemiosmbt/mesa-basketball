import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mesa Basketball Training | Artemios Gavalas",
  description:
    "Basketball training with former Division I player Artemios Gavalas. Group sessions, private training, and mini camps.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
