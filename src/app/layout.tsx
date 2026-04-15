import type { Metadata } from "next";
import { Oswald, Fira_Sans_Condensed } from "next/font/google";
import "./globals.css";
import { AppInstallBanner, AppInstallDesktopPopup } from "./AppInstall";

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
  title: {
    default: "Mesa Basketball Training | Long Island",
    template: "%s | Mesa Basketball Training",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
  description:
    "Elite basketball training on Long Island with former D1 and international professional player Artemios Gavalas. Group sessions, private lessons, and mini camps for all ages.",
  keywords: [
    "basketball training Long Island",
    "youth basketball training Long Island",
    "private basketball lessons Long Island",
    "basketball camps Long Island",
    "basketball trainer Nassau County",
    "basketball trainer Suffolk County",
    "elite basketball training Long Island",
    "AAU basketball training Long Island",
    "Artemios Gavalas",
    "Mesa Basketball Training",
  ],
  metadataBase: new URL("https://www.mesabasketballtraining.com"),
  openGraph: {
    title: "Mesa Basketball Training | Long Island",
    description: "Elite basketball training on Long Island with former D1 and international professional player Artemios Gavalas.",
    url: "https://www.mesabasketballtraining.com",
    siteName: "Mesa Basketball Training",
    images: [{ url: "/og-image.jpg", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mesa Basketball Training | Long Island",
    description: "Elite basketball training on Long Island. Group sessions, private lessons, and mini camps.",
    images: ["/og-image.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${oswald.variable} ${firaCond.variable} antialiased`}>
        {children}
        <AppInstallBanner />
        <AppInstallDesktopPopup />
      </body>
    </html>
  );
}
