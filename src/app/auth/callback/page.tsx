"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "error">("loading");

  useEffect(() => {
    // Check for an error in the hash (e.g. expired link from Supabase)
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    if (hashParams.get("error")) {
      setStatus("error");
      setTimeout(() => router.replace("/login?confirm_error=1"), 2000);
      return;
    }

    // With implicit flow, Supabase auto-processes the hash tokens and fires SIGNED_IN.
    // We listen for that event, save any pending profile, then redirect to login.
    const timeoutId = setTimeout(() => {
      setStatus("error");
      setTimeout(() => router.replace("/login?confirm_error=1"), 2000);
    }, 10000);

    const { data: { subscription } } = authClient.auth.onAuthStateChange(
      async (event, session) => {
        if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) {
          clearTimeout(timeoutId);

          // Save any pending profile data stored during signup
          const pending = localStorage.getItem("mesa_pending_profile");
          if (pending) {
            try {
              const profile = JSON.parse(pending);
              await fetch("/api/profile", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${session.access_token}`,
                },
                body: JSON.stringify(profile),
              });
              localStorage.removeItem("mesa_pending_profile");
            } catch {
              // non-critical
            }
          }

          router.replace("/login?confirmed=1");
        }
      }
    );

    return () => {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, [router]);

  return (
    <div className="min-h-screen bg-brown-950 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="h-28 w-28 mx-auto rounded-full bg-white overflow-hidden flex items-center justify-center">
          <img src="/logo.png" alt="Mesa Basketball" className="h-28 w-28 object-contain scale-125" />
        </div>
        {status === "loading" ? (
          <p className="text-brown-300 text-sm">Confirming your email...</p>
        ) : (
          <p className="text-red-400 text-sm">That link has expired. Redirecting you to sign in...</p>
        )}
      </div>
    </div>
  );
}
