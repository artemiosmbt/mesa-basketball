import type { Metadata } from "next";
import { Oswald, Roboto_Condensed } from "next/font/google";
import "./globals.css";

const oswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-oswald",
});

const robotoCond = Roboto_Condensed({
  subsets: ["latin", "greek"],
  weight: ["700", "900"],
  variable: "--font-roboto-cond",
});

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
      <body className={`${oswald.variable} ${robotoCond.variable} antialiased`}>{children}</body>
    </html>
  );
}
