"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

const chevron = (open?: boolean) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 mt-0.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

export default function LandingNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [schedulingOpen, setSchedulingOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    authClient.auth.getSession().then(({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? null);
    });
  }, []);

  async function handleSignOut() {
    await authClient.auth.signOut();
    setUserEmail(null);
    router.push("/");
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-mesa-dark -ml-5 md:ml-0">
          <div className="h-10 w-[120px] flex items-center overflow-visible">
            <img src="/logo.png" alt="Mesa Basketball Logo" className="h-[120px] w-[120px] object-contain" />
          </div>
          <span className="hidden sm:inline">ΜΕΣΑ BASKETBALL</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/" className="hidden md:inline text-brown-600 hover:text-mesa-dark">Home</Link>
          <span className="hidden md:inline text-brown-300">|</span>
          <Link href="/about" className="hidden md:inline text-brown-600 hover:text-mesa-dark">About</Link>
          <span className="hidden md:inline text-brown-300">|</span>
          {/* Desktop Scheduling dropdown */}
          <div className="relative group hidden md:block">
            <Link href="/schedule" className="flex items-center gap-1 text-brown-600 hover:text-mesa-dark">
              Programs {chevron()}
            </Link>
            <div className="absolute top-full left-0 w-44 z-50 hidden group-hover:block pt-2">
              <div className="rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                <Link href="/schedule#schedule" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Group Sessions</Link>
                <Link href="/schedule#camps" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Camps</Link>
                <Link href="/schedule#private" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Private Sessions</Link>
              </div>
            </div>
          </div>
          <span className="hidden md:inline text-brown-300">|</span>
          {/* Account / Login */}
          {userEmail ? (
            <div className="relative group hidden md:block">
              <button className="flex items-center gap-1 rounded bg-brown-600/20 px-3 py-1 text-brown-600 hover:bg-brown-600/30">
                Account {chevron()}
              </button>
              <div className="absolute top-full right-0 w-44 z-50 hidden group-hover:block pt-2">
                <div className="rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                  <div className="px-4 py-2 border-b border-gray-100">
                    <p className="text-xs text-brown-400">Signed in as</p>
                    <p className="text-xs font-medium text-brown-700 truncate max-w-[160px]">{userEmail}</p>
                  </div>
                  <Link href="/my-bookings" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">My Bookings</Link>
                  <Link href="/settings" className="block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Settings</Link>
                  {userEmail === ADMIN_EMAIL && (
                    <Link href="/admin" className="block px-4 py-2 text-mesa-accent hover:text-yellow-600 hover:bg-gray-50 font-medium">Admin</Link>
                  )}
                  <div className="border-t border-gray-100 mt-1 pt-1">
                    <button onClick={handleSignOut} className="w-full text-left block px-4 py-2 text-brown-600 hover:text-mesa-dark hover:bg-gray-50">Sign Out</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <Link href="/login" className="hidden md:inline rounded bg-brown-600/20 px-3 py-1 text-brown-600 hover:bg-brown-600/30">Login</Link>
          )}
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hidden md:inline text-brown-600 hover:text-mesa-dark">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
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
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-gray-200 bg-white px-6 py-4 space-y-4 text-sm">
          <Link href="/" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">Home</Link>
          <Link href="/about" onClick={() => setMobileMenuOpen(false)} className="block text-brown-600 hover:text-mesa-dark py-1">About</Link>
          <div>
            <button onClick={() => setSchedulingOpen((o) => !o)} className="flex items-center justify-between w-full text-brown-600 hover:text-mesa-dark py-1">
              Programs {chevron(schedulingOpen)}
            </button>
            {schedulingOpen && (
              <div className="ml-4 mt-1 space-y-1">
                <Link href="/schedule#schedule" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Group Sessions</Link>
                <Link href="/schedule#camps" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Camps</Link>
                <Link href="/schedule#private" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Private Sessions</Link>
              </div>
            )}
          </div>
          <a href="https://www.instagram.com/mesabasketballtraining" target="_blank" rel="noopener noreferrer" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 text-brown-600 hover:text-mesa-dark py-1">
            Instagram
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <circle cx="12" cy="12" r="4" />
              <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
          {userEmail ? (
            <>
              <div>
                <button onClick={() => setAccountOpen((o) => !o)} className="flex items-center justify-between w-full rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 font-medium">
                  Account {chevron(accountOpen)}
                </button>
                {accountOpen && (
                  <div className="ml-4 mt-1 space-y-1">
                    <p className="text-xs text-brown-400 py-1">Signed in as <span className="font-medium text-brown-600">{userEmail}</span></p>
                    <Link href="/my-bookings" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">My Bookings</Link>
                    <Link href="/settings" onClick={() => setMobileMenuOpen(false)} className="block text-brown-500 hover:text-mesa-dark py-1">Settings</Link>
                    {userEmail === ADMIN_EMAIL && (
                      <Link href="/admin" onClick={() => setMobileMenuOpen(false)} className="block text-mesa-accent hover:text-yellow-600 py-1 font-medium">Admin</Link>
                    )}
                    <button onClick={handleSignOut} className="block text-brown-500 hover:text-mesa-dark py-1">Sign Out</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <Link href="/login" onClick={() => setMobileMenuOpen(false)} className="block rounded bg-brown-600/20 px-3 py-2 text-brown-600 hover:bg-brown-600/30 text-center font-medium">Login</Link>
          )}
        </div>
      )}
    </nav>
  );
}
