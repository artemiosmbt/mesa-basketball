"use client";

import { useState } from "react";
import Link from "next/link";

export default function AboutNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-2 md:px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-mesa-dark">
          <div className="h-10 w-[120px] flex items-center overflow-visible">
            <img src="/logo.png" alt="Mesa Basketball Logo" className="h-[120px] w-[120px] object-contain" />
          </div>
          <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/#schedule" className="hidden md:inline text-brown-600 hover:text-mesa-dark">Schedule</Link>
          <Link href="/#camps" className="hidden md:inline text-brown-600 hover:text-mesa-dark">Camps</Link>
          <Link href="/#private" className="hidden md:inline text-brown-600 hover:text-mesa-dark">Private Sessions</Link>
          <Link href="/about" className="hidden md:inline text-mesa-accent font-medium">About</Link>
          <Link href="/my-bookings" className="hidden md:inline rounded bg-mesa-accent/20 px-3 py-1 text-mesa-accent hover:bg-mesa-accent/30">My Bookings</Link>
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hidden md:inline text-brown-600 hover:text-mesa-dark">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
          {/* Mobile hamburger */}
          <button
            className="md:hidden text-brown-600 hover:text-mesa-dark p-1"
            onClick={() => setMobileMenuOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {/* Mobile dropdown menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-gray-200 bg-white px-6 py-4 space-y-4 text-sm">
          <Link href="/#schedule" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">Schedule</Link>
          <Link href="/#camps" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">Camps</Link>
          <Link href="/#private" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">Private Sessions</Link>
          <Link href="/about" onClick={() => setMobileMenuOpen(false)} className="block text-mesa-accent font-medium py-1">About</Link>
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 text-brown-600 hover:text-mesa-dark py-1">
            Instagram
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
          <Link href="/my-bookings" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-mesa-accent/20 px-3 py-2 text-mesa-accent hover:bg-mesa-accent/30 text-center font-medium">My Bookings</Link>
        </div>
      )}
    </nav>
  );
}
