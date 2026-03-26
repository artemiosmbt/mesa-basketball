"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error } = await authClient.auth.resetPasswordForEmail(email, {
      redirectTo: "https://www.mesabasketballtraining.com/reset-password",
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="h-28 w-28 mx-auto mb-6 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide mb-4">CHECK YOUR EMAIL</h1>
          <div className="bg-brown-900/40 border border-brown-700 rounded-xl px-8 py-8 space-y-4">
            <p className="text-brown-200 text-base leading-relaxed">
              A password reset link has been sent to <span className="text-white font-semibold">{email}</span>.
            </p>
            <p className="text-brown-400 text-sm leading-relaxed">
              Click the link in the email to set a new password. Check your spam folder if you don&apos;t see it within a minute.
            </p>
            <Link
              href="/login"
              className="block w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition text-center mt-2"
            >
              Back to Sign In
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
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">RESET PASSWORD</h1>
          <p className="text-brown-400 mt-1 text-sm">We&apos;ll send you a link to reset it</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-brown-900/40 border border-brown-700 rounded-xl px-8 py-8 space-y-5">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-brown-700 bg-brown-800/60 px-4 py-2.5 text-white placeholder-brown-500 focus:border-mesa-accent focus:outline-none"
              placeholder="parent@email.com"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-mesa-accent py-3 font-bold text-white hover:bg-mesa-accent/90 transition disabled:opacity-50"
          >
            {loading ? "Sending..." : "Send Reset Link"}
          </button>
        </form>
        <p className="text-center mt-6">
          <Link href="/login" className="text-brown-500 hover:text-brown-300 text-xs">← Back to Sign In</Link>
        </p>
      </div>
    </div>
  );
}
