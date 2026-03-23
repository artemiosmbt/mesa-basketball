import type { Metadata } from "next";
import { Oswald, Exo_2 } from "next/font/google";
import "./globals.css";

const oswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-oswald",
});

const exo2 = Exo_2({
  subsets: ["latin", "greek"],
  weight: ["700", "800", "900"],
  variable: "--font-exo2",
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
      <body className={`${oswald.variable} ${exo2.variable} antialiased`}>{children}</body>
    </html>
  );
}
