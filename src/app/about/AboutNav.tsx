"use client";

import { useState } from "react";
import Link from "next/link";

export default function AboutNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 border-b border-brown-800 bg-mesa-dark/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-white">
          <img src="/logo.jpeg" alt="Mesa Basketball Logo" className="h-10 w-10 rounded-full object-cover" />
          <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/#schedule" className="hidden md:inline text-brown-300 hover:text-white">Schedule</Link>
          <Link href="/#camps" className="hidden md:inline text-brown-300 hover:text-white">Camps</Link>
          <Link href="/#private" className="hidden md:inline text-brown-300 hover:text-white">Private Sessions</Link>
          <Link href="/about" className="hidden md:inline text-mesa-accent font-medium">About</Link>
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hidden md:inline text-brown-300 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
          <Link href="/my-bookings" className="rounded bg-mesa-accent/20 px-3 py-1 text-mesa-accent hover:bg-mesa-accent/30">My Bookings</Link>
          {/* Mobile hamburger */}
          <button
            className="md:hidden text-brown-300 hover:text-white p-1"
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
        <div className="md:hidden border-t border-brown-800 bg-mesa-dark/98 px-6 py-4 space-y-4 text-sm">
          <Link href="/#schedule" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Schedule</Link>
          <Link href="/#camps" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Camps</Link>
          <Link href="/#private" onClick={() => setMobileMenuOpen(false)} className="block text-brown-300 hover:text-white py-1">Private Sessions</Link>
          <Link href="/about" onClick={() => setMobileMenuOpen(false)} className="block text-mesa-accent font-medium py-1">About</Link>
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 text-brown-300 hover:text-white py-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
            Instagram
          </a>
          <Link href="/my-bookings" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-mesa-accent/20 px-3 py-2 text-mesa-accent hover:bg-mesa-accent/30 text-center font-medium">My Bookings</Link>
        </div>
      )}
    </nav>
  );
}
