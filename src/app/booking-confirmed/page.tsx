"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function BookingConfirmedContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");

  return (
    <div className="min-h-screen bg-mesa-dark text-white flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="mb-6 text-5xl">✓</div>
        <h1 className="font-[family-name:var(--font-fira-cond)] text-3xl font-black tracking-wide mb-4">
          PAYMENT RECEIVED
        </h1>
        <p className="text-brown-300 leading-relaxed mb-2">
          Your session is confirmed. You&apos;ll get a confirmation email and text shortly with all the details.
        </p>
        {!sessionId && (
          <p className="text-brown-500 text-sm mb-6">
            If you don&apos;t see a confirmation in a few minutes, contact us and we&apos;ll sort it out.
          </p>
        )}
        <div className="mt-8 flex flex-col gap-3 items-center">
          <Link href="/my-bookings" className="rounded-lg bg-mesa-accent px-8 py-3 font-semibold text-white hover:bg-yellow-600 transition">
            View My Bookings
          </Link>
          <Link href="/" className="text-sm text-brown-400 hover:text-white transition">
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BookingConfirmedPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-mesa-dark" />}>
      <BookingConfirmedContent />
    </Suspense>
  );
}
