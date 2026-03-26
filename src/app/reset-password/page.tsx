"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // Supabase processes the recovery token from the URL hash automatically.
    // Wait briefly for it to settle, then check for a valid session.
    const timer = setTimeout(async () => {
      const { data: { session } } = await authClient.auth.getSession();
      if (session) {
        setReady(true);
      } else {
        setError("This reset link is invalid or has expired. Please request a new one.");
      }
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    setError("");
    const { error } = await authClient.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setDone(true);
      setTimeout(() => router.push("/my-bookings"), 2000);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="h-28 w-28 mx-auto mb-6 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide mb-4">PASSWORD UPDATED</h1>
          <p className="text-brown-300 text-sm">Your password has been changed. Redirecting you now...</p>
        </div>
      </div>
    );
  }

  if (!ready && !error) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center">
        <p className="text-brown-400 text-sm">Verifying reset link...</p>
      </div>
    );
  }

  if (error && !ready) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="h-28 w-28 mx-auto mb-6 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-8 py-8 space-y-4">
            <p className="text-red-400 text-sm">{error}</p>
            <Link
              href="/forgot-password"
              className="block w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition text-center"
            >
              Request New Link
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="h-28 w-28 mx-auto mb-4 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">NEW PASSWORD</h1>
          <p className="text-brown-400 mt-1 text-sm">Choose a new password for your account</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-brown-900/40 border border-brown-700 rounded-xl px-8 py-8 space-y-5">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
              placeholder="Min. 6 characters"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50"
          >
            {loading ? "Updating..." : "Update Password"}
          </button>
        </form>
      </div>
    </div>
  );
}
