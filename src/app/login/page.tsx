"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, ADMIN_EMAIL } from "@/lib/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push(data.user?.email === ADMIN_EMAIL ? "/admin" : "/my-bookings");
    }
  }

  return (
    <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="h-24 w-24 mx-auto mb-4 rounded-full bg-white flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-20 w-20 object-contain" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">SIGN IN</h1>
          <p className="text-brown-400 mt-1 text-sm">Mesa Basketball Training</p>
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
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-brown-400 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
        <p className="text-center text-brown-400 mt-6 text-sm">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-mesa-accent hover:underline">Create one</Link>
        </p>
        <p className="text-center mt-3">
          <Link href="/" className="text-brown-500 hover:text-brown-300 text-xs">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}
