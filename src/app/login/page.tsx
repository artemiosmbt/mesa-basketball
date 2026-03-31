"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth";

async function resendConfirmationEmail(email: string) {
  return authClient.auth.resend({ type: "signup", email, options: { emailRedirectTo: "https://www.mesabasketballtraining.com/auth/callback" } });
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [unconfirmedEmail, setUnconfirmedEmail] = useState("");
  const [resendStatus, setResendStatus] = useState("");
  const [info, setInfo] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("confirmed") === "1") {
        return "Email confirmed! Please sign in to continue.";
      }
    }
    return "";
  });
  const [initError] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("confirm_error") === "1") {
        return "That confirmation link has expired or already been used. Request a new one below.";
      }
    }
    return "";
  });
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes("not confirmed")) {
        setUnconfirmedEmail(email);
        setError("email_not_confirmed");
      } else {
        setError(error.message);
      }
      setLoading(false);
    } else {
      // Save any pending profile data from signup (when email confirmation was required)
      const pending = localStorage.getItem("mesa_pending_profile");
      if (pending && data.session) {
        try {
          const profile = JSON.parse(pending);
          await fetch("/api/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${data.session.access_token}`,
            },
            body: JSON.stringify(profile),
          });
          localStorage.removeItem("mesa_pending_profile");
        } catch {
          // non-critical, ignore
        }
      }
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next || "/");
    }
  }

  return (
    <div className="min-h-screen bg-brown-950 flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="h-28 w-28 mx-auto mb-4 rounded-full bg-white overflow-hidden flex items-center justify-center">
            <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
          </div>
          <h1 className="font-[family-name:var(--font-oswald)] text-3xl font-bold text-white tracking-wide">SIGN IN</h1>
          <p className="text-brown-400 mt-1 text-sm">Mesa Basketball Training</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-brown-900/40 border border-brown-700 rounded-xl px-8 py-8 space-y-5">
          {info && <p className="text-green-400 text-sm text-center">{info}</p>}
          {initError && <p className="text-yellow-400 text-sm text-center">{initError}</p>}
          {error === "email_not_confirmed" ? (
            <div className="text-center space-y-2">
              <p className="text-red-400 text-sm">Your email hasn&apos;t been confirmed yet. Check your inbox (and spam) for a confirmation link.</p>
              <button
                type="button"
                onClick={async () => {
                  setResendStatus("sending");
                  const { error: resendErr } = await resendConfirmationEmail(unconfirmedEmail);
                  setResendStatus(resendErr ? "error" : "sent");
                }}
                disabled={resendStatus === "sending" || resendStatus === "sent"}
                className="text-sm text-mesa-accent hover:underline disabled:opacity-50"
              >
                {resendStatus === "sending" ? "Sending..." : resendStatus === "sent" ? "Confirmation email resent!" : resendStatus === "error" ? "Failed to resend — try again" : "Resend confirmation email"}
              </button>
            </div>
          ) : error ? (
            <p className="text-red-400 text-sm text-center">{error}</p>
          ) : null}
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
          <div className="flex justify-end -mt-2">
            <Link href="/forgot-password" className="text-xs text-brown-400 hover:text-mesa-accent">
              Forgot password?
            </Link>
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
