import type { Metadata } from "next";
import { Oswald, Fira_Sans_Condensed } from "next/font/google";
import "./globals.css";

const oswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-oswald",
});

const firaCond = Fira_Sans_Condensed({
  subsets: ["latin", "greek"],
  weight: ["700", "800", "900"],
  variable: "--font-fira-cond",
});

export const metadata: Metadata = {
  title: "Mesa Basketball Training",
  description:
    "Elite basketball training on Long Island. Group sessions, private training, and mini camps.",
  openGraph: {
    title: "Mesa Basketball Training",
    description: "Elite basketball training on Long Island. Group sessions, private training, and mini camps.",
    url: "https://mesabasketballtraining.com",
    siteName: "Mesa Basketball Training",
    images: [{ url: "/og-image.jpg", width: 1200, height: 630 }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${oswald.variable} ${firaCond.variable} antialiased`}>{children}</body>
    </html>
  );
}
